import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AiActivity } from '@contracts/aiSessions.contract';
import {
  comparisonDetailSchema,
  comparisonItemSchema,
} from '@contracts/knowledgeComparisons.contract';
import type {
  KnowledgeComparisonListRequest,
  KnowledgeComparisonReadRequest,
  KnowledgeComparisonRestartRequest,
  KnowledgeComparisonPageResult,
  KnowledgeComparisonDetailResult,
  KnowledgeComparisonDetail,
  KnowledgeComparisonLocal,
} from '@contracts/knowledgeComparisons.contract';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import { apiFailure, readScopedApiJson, matchesExpectedScope } from './readApi';
import type { ApiFailure, ReadApiResult } from './readApi';
import { aiModelArguments, personalAi } from './personalAi';
import type { PersonalAi } from './personalAi';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  spawnPersonalProcess,
  personalRuntimePaths,
  observePersonalProcess,
  stopPersonalProcess,
} from './personalProcess';
import {
  readProcessJournal,
  writeProcessJournal,
  removeProcessJournal,
} from './processRecovery';
import type { ProcessRecovery } from './processRecovery';
import { ExecutionStarts } from './ExecutionStarts';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const envelope = z.object({
  data: z.looseObject({
    access: z.object({
      user_id: z.string(),
      tenant: z.string(),
      profile_id: z.string(),
      policy_revision: z.string(),
      access_revision: z.string().nullish(),
    }),
  }),
});
const page = z.object({
  items: z.array(comparisonItemSchema),
  latest_id: id.nullable(),
  next_cursor: z.string().min(1).max(16384).nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.unknown()),
});
const journalSchema = z.object({ comparisonId: id, requestId: id });
const cancellationSchema = journalSchema.extend({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
type Running = {
  child: ChildProcess;
  closed: Promise<void>;
  stopping: boolean;
  context: AnalysisContext;
  activity: AiActivity;
};
export type ComparisonRuntime = {
  projectRoot: string;
  python: string;
  privateRoot: string;
  ai: PersonalAi;
};
export type ComparisonConnection = Pick<
  ConnectionService,
  | 'analysisContext'
  | 'isAnalysisCurrent'
  | 'analysisAccessFailure'
  | 'onScopeChanged'
>;

/** 실행 경로와 제공자는 main 설정에서만 읽고 사용자 본문으로 명령을 조립하지 않습니다. */
async function defaultRuntime(): Promise<ComparisonRuntime> {
  const { app } = await import('electron');
  const { projectRoot, python } = personalRuntimePaths();
  await access(python);
  await access(join(projectRoot, 'tools/comparison_cli.py'));
  return {
    projectRoot,
    python,
    ai: await personalAi('analysis'),
    privateRoot: join(app.getPath('userData'), 'comparisons'),
  };
}
/** 공개 오류에는 원문·토큰·로컬 경로를 넣지 않습니다. */
function changed(): ApiFailure {
  return apiFailure(
    'scope_changed',
    '연결 또는 작업 공간이 변경되었습니다. 현재 범위에서 다시 확인해 주세요.',
  );
}
/** 로컬 실행 상태를 연결·주체·권한 판본별로 격리합니다. */
function keyFor(request: KnowledgeComparisonReadRequest): string {
  return JSON.stringify([
    request.connectionId,
    request.expectedScope,
    request.comparisonId,
  ]);
}
/** 서버 보관 기록과 로컬 프로세스 수명은 독립적으로 표시합니다. */
function idle(): KnowledgeComparisonLocal {
  return {
    status: 'idle',
    message: '',
    requestId: null,
    resultId: null,
    cleanupWarning: false,
  };
}

/** 이전 비교는 보존하고 명시한 검색·대조 재실행만 같은 AI 세션에서 시작합니다. */
export class KnowledgeComparisonService {
  #connection: ComparisonConnection;
  #recovery: ProcessRecovery | undefined;
  #runtime: () => Promise<ComparisonRuntime>;
  #running = new Map<string, Running>();
  #local = new Map<string, KnowledgeComparisonLocal>();
  #starts = new ExecutionStarts();
  #sessionOwners = new Map<string, string>();
  #requests = new Set<AbortController>();
  #epoch = 0;
  constructor(
    connection: ComparisonConnection,
    recovery?: ProcessRecovery,
    runtime: () => Promise<ComparisonRuntime> = defaultRuntime,
  ) {
    this.#connection = connection;
    this.#recovery = recovery;
    this.#runtime = runtime;
    connection.onScopeChanged((): void => {
      for (const request of this.#requests) request.abort();
      void this.shutdown();
      this.#local.clear();
    });
  }
  /** 렌더러가 보낸 주체·권한 기준을 현재 인증 상태와 먼저 대조합니다. */
  async #context(
    request: KnowledgeComparisonListRequest | KnowledgeComparisonReadRequest,
  ): Promise<AnalysisContext | ApiFailure> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    if (!matchesExpectedScope(request.expectedScope, context)) return changed();
    return context;
  }
  /** HTTP 응답의 접근 기준도 검증하고 계정 변경 뒤 응답을 버립니다. */
  async #api(
    context: AnalysisContext,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ReadApiResult> {
    return readScopedApiJson(this.#connection, this.#requests, context, path, {
      body,
      schema: envelope,
      changed,
      profile: 'query',
      maxResponseBytes: 16 * 1024 * 1024,
      invalidMessage: '기존 지식 대조 응답을 확인할 수 없습니다.',
    });
  }
  /** 이전 비교 목록은 읽기만 하며 오래된 결과를 삭제하거나 재대조하지 않습니다. */
  async list(
    request: KnowledgeComparisonListRequest,
  ): Promise<KnowledgeComparisonPageResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const query = new URLSearchParams({ limit: '50' });
    if (request.document) query.set('document', request.document);
    if (request.jobId) query.set('job_id', request.jobId);
    if (request.cursor) query.set('cursor', request.cursor);
    const result = await this.#api(
      context,
      `knowledge-comparisons?${query.toString()}`,
    );
    if (!result.ok) return result;
    const parsed = page.safeParse(result.value);
    if (!parsed.success)
      return apiFailure(
        'invalid_response',
        '대조 실행 목록을 확인할 수 없습니다.',
      );
    return {
      ok: true,
      data: {
        items: parsed.data.items,
        latestId: parsed.data.latest_id,
        nextCursor: parsed.data.next_cursor,
        incomplete:
          !parsed.data.complete ||
          parsed.data.truncated ||
          parsed.data.skipped.length > 0,
      },
    };
  }
  /** 복구된 요청은 같은 영수증으로만 확인하며 새 실행을 만들지 않습니다. */
  async #reconcile(
    context: AnalysisContext,
    request: KnowledgeComparisonReadRequest,
    comparison: KnowledgeComparisonDetail,
  ): Promise<KnowledgeComparisonLocal> {
    const key = keyFor(request);
    let local = this.#local.get(key) ?? idle();
    const entries = await readProcessJournal(
      this.#recovery,
      context,
      'pending-analysis',
    );
    const cancellation = entries.find(
      (item: RecoveryEntry): boolean =>
        item.key === `compare-cancel:${request.comparisonId}`,
    );
    if (cancellation) {
      const saved = cancellationSchema.parse(JSON.parse(cancellation.payload));
      if (saved.comparisonId !== request.comparisonId)
        throw new Error('recovery_mismatch');
      const receipt = await this.#api(
        context,
        `personal-requests/knowledge-comparisons/${saved.requestId}?record_id=${saved.comparisonId}`,
      );
      const confirmed = receipt.ok
        ? z
            .object({
              request_confirmed: z.literal(true),
              request_id: id,
              record: z.object({ id, tenant: z.string(), user_id: z.string() }),
            })
            .safeParse(receipt.value)
        : null;
      if (
        confirmed?.success &&
        confirmed.data.request_id === saved.requestId &&
        confirmed.data.record.id === request.comparisonId &&
        confirmed.data.record.tenant === context.selection.tenant &&
        confirmed.data.record.user_id === context.active.userId
      ) {
        try {
          await removeProcessJournal(this.#recovery, context, cancellation);
        } catch {
          local = { ...local, cleanupWarning: true };
        }
        local = {
          ...local,
          status: 'exited',
          requestId: null,
          message: '대조 중단 기록이 보관되었습니다.',
        };
      } else if (comparison.status === 'running') {
        local = {
          ...local,
          status: 'unconfirmed',
          requestId: saved.requestId,
          message:
            '중단 기록의 저장 결과가 미확인입니다. 중단을 다시 누르면 같은 요청으로 확인합니다.',
        };
      } else {
        // 서버가 다른 결과로 닫힌 경우에도 불확실한 요청 원본은 보존합니다.
        local = {
          ...local,
          requestId:
            local.requestId === saved.requestId ? null : local.requestId,
          status: 'exited',
          cleanupWarning: true,
        };
      }
      this.#local.set(key, local);
    }
    const entry = entries.find(
      (item: RecoveryEntry): boolean =>
        item.key === `compare:${request.comparisonId}`,
    );
    if (!entry) return local;
    const saved = journalSchema.parse(JSON.parse(entry.payload));
    if (saved.comparisonId !== request.comparisonId)
      throw new Error('recovery_mismatch');
    local = {
      ...local,
      requestId: saved.requestId,
      status: this.#running.has(key) ? local.status : 'unconfirmed',
      message: this.#running.has(key)
        ? local.message
        : '재대조 실행의 저장 결과를 확인하고 있습니다.',
    };
    const receipt = await this.#api(
      context,
      `personal-requests/knowledge-comparisons/${saved.requestId}`,
    );
    if (receipt.ok) {
      const parsed = z
        .object({
          request_confirmed: z.literal(true),
          request_id: id,
          record: z.object({
            id,
            kind: z.literal('knowledge-comparisons'),
            user_id: z.string(),
            tenant: z.string(),
            data: z.object({ document: z.string(), session_id: z.string() }),
            events: z.array(z.looseObject({ kind: z.string() })),
          }),
        })
        .safeParse(receipt.value);
      if (
        parsed.success &&
        parsed.data.request_id === saved.requestId &&
        parsed.data.record.user_id === context.active.userId &&
        parsed.data.record.tenant === context.selection.tenant &&
        parsed.data.record.data.document === comparison.record.data.document &&
        parsed.data.record.data.session_id === comparison.record.data.session_id
      ) {
        local.resultId = parsed.data.record.id;
        if (
          parsed.data.record.events.some(
            (event: (typeof parsed.data.record.events)[number]): boolean =>
              event.kind === 'result',
          )
        ) {
          local = {
            ...local,
            status: this.#running.has(key) ? local.status : 'exited',
            message: '새 대조 결과가 보관되었습니다.',
            requestId: null,
          };
          try {
            await removeProcessJournal(this.#recovery, context, entry);
          } catch {
            local = { ...local, cleanupWarning: true };
          }
        }
      }
    } else if (
      [
        'scope_changed',
        'connection_changed',
        'forbidden',
        'unauthorized',
      ].includes(receipt.error.code)
    )
      throw new Error('scope_changed');
    this.#local.set(key, local);
    return local;
  }
  /** 원래 비교의 판본과 소유권을 읽고 재실행의 영수증을 따로 확인합니다. */
  async read(
    request: KnowledgeComparisonReadRequest,
  ): Promise<KnowledgeComparisonDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#api(
      context,
      `knowledge-comparisons/${request.comparisonId}`,
    );
    if (!result.ok) return result;
    const parsed = comparisonDetailSchema.safeParse(result.value);
    if (
      !parsed.success ||
      parsed.data.record.id !== request.comparisonId ||
      parsed.data.record.tenant !== context.selection.tenant ||
      parsed.data.record.user_id !== context.active.userId
    )
      return apiFailure(
        'invalid_response',
        '대조 결과의 대상과 소유권을 확인할 수 없습니다.',
      );
    try {
      const local = await this.#reconcile(context, request, parsed.data);
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      return { ok: true, data: { comparison: parsed.data, local } };
    } catch {
      return apiFailure(
        'recovery_unavailable',
        '대조 결과는 보관돼 있지만 재실행 확인 기록을 읽지 못했습니다. 새 실행을 시작하지 않았습니다.',
      );
    }
  }
  /** 같은 원 비교에 중복 프로세스를 만들지 않고 새 접수 ID를 먼저 보호 저장합니다. */
  async restart(
    request: KnowledgeComparisonRestartRequest,
  ): Promise<KnowledgeComparisonDetailResult> {
    const key = keyFor(request);
    const finish = this.#running.has(key) ? null : this.#starts.begin(key);
    if (!finish)
      return apiFailure(
        'comparison_busy',
        '이 대조의 재실행이 이미 진행 중입니다.',
      );
    const epoch = this.#epoch;
    let reservedSession: string | null = null;
    let spawned = false;
    try {
      const context = await this.#context(request);
      if ('ok' in context) return context;
      const detail = await this.read(request);
      if (!detail.ok) return detail;
      if (detail.data.comparison.revision !== request.expectedRevision)
        return apiFailure(
          'conflict',
          '비교 기록이 변경되었습니다. 최신 상태를 읽고 다시 실행해 주세요.',
          409,
        );
      if (detail.data.local.requestId !== null)
        return apiFailure(
          'outcome_unknown',
          '이전 재실행의 저장 결과를 먼저 확인해 주세요.',
        );
      if (detail.data.comparison.status === 'running')
        return apiFailure(
          'comparison_busy',
          '현재 대조가 아직 진행 중입니다. 저장된 완료·미완료 결과를 확인한 뒤 다시 실행해 주세요.',
        );
      if (!this.#recovery)
        return apiFailure(
          'recovery_unavailable',
          '실행 요청을 보호 저장할 수 없습니다.',
        );
      const sessionKey = JSON.stringify([
        request.connectionId,
        request.expectedScope,
        detail.data.comparison.record.data.session_id,
      ]);
      if (this.#sessionOwners.has(sessionKey))
        return apiFailure(
          'comparison_busy',
          '같은 AI 세션의 다른 대조가 진행 중입니다.',
        );
      this.#sessionOwners.set(sessionKey, key);
      reservedSession = sessionKey;
      const runtime = await this.#runtime();
      if (
        !detail.data.comparison.record.data.provider ||
        detail.data.comparison.record.data.provider !== runtime.ai.provider
      )
        return apiFailure(
          'comparison_provider_mismatch',
          '이 대조를 시작한 AI 제공자와 현재 실행 설정이 다릅니다. 원래 제공자를 선택해 주세요.',
        );
      await assertPersonalRuntime(runtime);
      await this.#spawn(
        context,
        request,
        detail.data.comparison.record.data.document,
        runtime,
        epoch,
        sessionKey,
      );
      spawned = true;
      return this.read(request);
    } catch {
      return apiFailure(
        'comparison_start_failed',
        '대조 실행기를 시작하지 못했습니다. 개인 AI 연결과 저장 확인 상태를 확인해 주세요.',
      );
    } finally {
      if (!spawned && reservedSession !== null)
        this.#sessionOwners.delete(reservedSession);
      finish();
    }
  }
  /** 한 비교를 멈추며 이미 저장한 후보·조회·이전 실행은 유지합니다. */
  async stopLocal(
    request: KnowledgeComparisonReadRequest,
  ): Promise<KnowledgeComparisonDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    await this.#stopOne(keyFor(request));
    const original = await this.read(request);
    if (!original.ok) return original;
    const targetRequest = {
      ...request,
      comparisonId: original.data.local.resultId ?? request.comparisonId,
    };
    const target =
      targetRequest.comparisonId === request.comparisonId
        ? original
        : await this.read(targetRequest);
    if (!target.ok) return target;
    if (target.data.comparison.status === 'running') {
      if (!this.#recovery)
        return apiFailure(
          'recovery_unavailable',
          '대조 중단 요청을 보호 저장할 수 없습니다.',
        );
      let journal: RecoveryEntry | null;
      let saved: z.infer<typeof cancellationSchema>;
      try {
        const entries = await readProcessJournal(
          this.#recovery,
          context,
          'pending-analysis',
        );
        journal =
          entries.find(
            (entry: RecoveryEntry): boolean =>
              entry.key === `compare-cancel:${targetRequest.comparisonId}`,
          ) ?? null;
        saved = journal
          ? cancellationSchema.parse(JSON.parse(journal.payload))
          : {
              comparisonId: targetRequest.comparisonId,
              requestId: randomUUID().replaceAll('-', ''),
              expectedRevision: target.data.comparison.revision,
            };
        if (saved.comparisonId !== targetRequest.comparisonId)
          throw new Error('recovery_mismatch');
        journal ??= await writeProcessJournal(
          this.#recovery,
          context,
          'pending-analysis',
          `compare-cancel:${targetRequest.comparisonId}`,
          saved,
        );
      } catch {
        return apiFailure(
          'recovery_unavailable',
          '대조 중단 요청을 보존하지 못했습니다. 저장 상태를 다시 확인해 주세요.',
        );
      }
      const result = await this.#api(
        context,
        `knowledge-comparisons/${targetRequest.comparisonId}/result`,
        {
          request_id: saved.requestId,
          expected_revision: saved.expectedRevision,
          status: 'incomplete',
          candidates: [],
          excluded: [],
          unconfirmed: [
            '사용자가 대조를 중단했습니다. 이전 조회 기록은 보존됩니다.',
          ],
          failure: 'comparison_cancelled',
        },
      );
      if (!result.ok) {
        if (
          result.error.status &&
          result.error.status >= 400 &&
          result.error.status < 500
        ) {
          try {
            await removeProcessJournal(this.#recovery, context, journal);
          } catch {
            /* 확정 거절의 로컬 기록 정리 실패는 다음 조회에서 보존됩니다. */
          }
        }
        return result;
      }
      const response = comparisonDetailSchema.safeParse(result.value);
      if (
        !response.success ||
        response.data.record.id !== targetRequest.comparisonId ||
        response.data.status !== 'incomplete'
      )
        return apiFailure(
          'outcome_unknown',
          '중단 기록의 저장 결과를 확인하지 못했습니다. 같은 대조 결과를 다시 읽어 주세요.',
        );
      try {
        await removeProcessJournal(this.#recovery, context, journal);
        const targetKey = keyFor(targetRequest);
        const local = this.#local.get(targetKey) ?? idle();
        this.#local.set(targetKey, {
          ...local,
          status: 'exited',
          requestId:
            local.requestId === saved.requestId ? null : local.requestId,
          message: '대조 중단 기록이 보관되었습니다.',
        });
      } catch {
        const key = keyFor(request);
        this.#local.set(key, {
          ...(this.#local.get(key) ?? idle()),
          cleanupWarning: true,
        });
      }
    }
    return this.read(request);
  }
  /** 접수 중인 실행을 포함해 종료 전에 정리합니다. */
  async shutdown(): Promise<void> {
    this.#epoch += 1;
    await this.#starts.settled();
    await Promise.all(
      [...this.#running.keys()].map((key: string): Promise<void> =>
        this.#stopOne(key),
      ),
    );
  }
  /** 다른 세션과 분리된 소유 프로세스만 중단합니다. */
  async #stopOne(key: string): Promise<void> {
    const run = this.#running.get(key);
    if (!run) return;
    run.stopping = true;
    const local = this.#local.get(key);
    if (local)
      this.#local.set(key, {
        ...local,
        status: 'stopping',
        message: '대조 실행을 중단하고 저장 결과를 확인합니다.',
      });
    await stopPersonalProcess(run.child, run.closed);
  }
  /** 활동 목록은 현재 연결의 실행 위치만 공개합니다. */
  activities(): AiActivity[] {
    return [...this.#running.values()]
      .filter((run: Running): boolean =>
        this.#connection.isAnalysisCurrent(run.context),
      )
      .map((run: Running): AiActivity => ({
        ...run.activity,
        status: run.stopping ? 'stopping' : 'running',
      }));
  }
  /** 명시 종료 확인에 아직 준비 중인 실행도 포함합니다. */
  get activeCount(): number {
    return this.#running.size + this.#starts.size;
  }
  /** 고정 CLI 옵션과 보호 토큰 파일로 실행하며 출력은 서버 영수증으로 확인합니다. */
  async #spawn(
    context: AnalysisContext,
    request: KnowledgeComparisonRestartRequest,
    document: string,
    runtime: ComparisonRuntime,
    epoch: number,
    sessionKey: string,
  ): Promise<void> {
    const execution = await createPrivateExecution(
      runtime,
      runtime.privateRoot,
      context.token,
    );
    const requestId = randomUUID().replaceAll('-', '');
    let journal: RecoveryEntry | null = null;
    let child: ChildProcess;
    try {
      journal = await writeProcessJournal(
        this.#recovery,
        context,
        'pending-analysis',
        `compare:${request.comparisonId}`,
        { comparisonId: request.comparisonId, requestId },
      );
      if (epoch !== this.#epoch || !this.#connection.isAnalysisCurrent(context))
        throw new Error('scope_changed');
      child = spawnPersonalProcess(runtime, [
        '-B',
        '-m',
        'tools.comparison_cli',
        '--server',
        context.active.serverUrl.replace(/\/api\/v1\/$/, ''),
        '--tenant',
        context.selection.tenant,
        '--profile',
        context.selection.profile,
        '--comparison-id',
        request.comparisonId,
        '--request-id',
        requestId,
        '--token-file',
        execution.tokenFile,
        '--work-dir',
        execution.workDirectory,
        '--session-registry',
        join(dirname(runtime.privateRoot), 'ai-session-refs'),
        '--ai-provider',
        runtime.ai.provider,
        '--ai-cli',
        runtime.ai.cli,
        ...aiModelArguments(runtime.ai),
      ]);
    } catch {
      try {
        await removeProcessJournal(this.#recovery, context, journal);
      } finally {
        await execution.cleanupAuth();
      }
      throw new Error('comparison_spawn_failed');
    }
    const key = keyFor(request);
    this.#local.set(key, {
      ...idle(),
      status: 'running',
      message: '같은 AI 세션에서 기존 지식을 다시 대조하고 있습니다.',
      requestId,
    });
    const running: Running = {
      child,
      context,
      closed: Promise.resolve(),
      stopping: false,
      activity: {
        kind: 'comparison',
        id: request.comparisonId,
        connectionId: request.connectionId,
        document,
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    };
    running.closed = observePersonalProcess(child, {
      onClose: (): void => {
        const local = this.#local.get(key);
        if (local)
          this.#local.set(key, {
            ...local,
            status: 'unconfirmed',
            message: '실행이 종료되었습니다. 서버의 저장 결과를 확인해 주세요.',
          });
      },
      cleanup: (): Promise<void> => execution.cleanupAuth(),
      onCleanupError: (): void => {
        const latest = this.#local.get(key);
        if (latest) this.#local.set(key, { ...latest, cleanupWarning: true });
      },
      onFinished: (): void => {
        if (this.#running.get(key) === running) this.#running.delete(key);
        this.#sessionOwners.delete(sessionKey);
      },
    });
    this.#running.set(key, running);
  }
}
