import { personalAi } from './personalAi';
import type { PersonalAi } from './personalAi';
import type { ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import { apiFailure, readApiJson } from './readApi';
import type { ApiFailure, ReadApiResult } from './readApi';
import {
  readProcessJournal,
  writeProcessJournal,
  removeProcessJournal,
} from './processRecovery';
import type { ProcessRecovery } from './processRecovery';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  spawnPersonalProcess,
  stopPersonalProcess,
} from './personalProcess';
import type {
  QuestionSession,
  QuestionCreateRequest,
  QuestionCreationReceiptRequest,
  QuestionReadRequest,
  QuestionListRequest,
  QuestionStartRequest,
  QuestionCancelRequest,
  QuestionDetailResult,
  QuestionPageResult,
  QuestionLocal,
} from '@contracts/questionRuns.contract';
import { questionReceiptSchema } from '@contracts/questionRuns.contract';
import {
  projectQuestion,
  projectQuestionAnswers,
  idleQuestionLocal,
  applyQuestionCliEvent,
} from './questionRunProjection';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const envelopeSchema = z.object({
  data: z.looseObject({
    access: z.object({
      user_id: z.string(),
      tenant: z.string(),
      profile_id: z.string(),
      policy_revision: z.string(),
    }),
  }),
});
const pageSchema = z.object({
  items: z.array(
    z.object({
      id,
      title: z.string(),
      created_at: z.string(),
      kind: z.literal('question-runs'),
    }),
  ),
  next_cursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.unknown()),
});
export type QuestionConnection = Pick<
  ConnectionService,
  | 'analysisContext'
  | 'isAnalysisCurrent'
  | 'analysisAccessFailure'
  | 'onScopeChanged'
>;

type Running = {
  child: ChildProcess;
  key: string;
  closed: Promise<void>;
  stopping: boolean;
};
export type QuestionRuntime = {
  projectRoot: string;
  python: string;
  ai: PersonalAi;
  privateRoot: string;
};

/** renderer가 실행 경로·토큰을 정하지 못하도록 main의 설치 설정만 사용합니다. */
async function defaultRuntime(): Promise<QuestionRuntime> {
  const { app } = await import('electron');
  const projectRoot =
    process.env.WIKI_CLIENT_ROOT ||
    process.env.WIKI_ANALYSIS_PROJECT_ROOT ||
    resolve(import.meta.dirname, '../../..');
  const python =
    process.env.WIKI_CLIENT_PYTHON ||
    process.env.WIKI_PYTHON ||
    process.env.WIKI_ANALYSIS_PYTHON ||
    join(
      projectRoot,
      process.platform === 'win32'
        ? '.venv/Scripts/python.exe'
        : '.venv/bin/python',
    );
  const ai = await personalAi('question');
  await access(python);
  await access(join(projectRoot, 'tools/question_cli.py'));
  return {
    projectRoot,
    python,
    ai,
    privateRoot: join(app.getPath('userData'), 'questions'),
  };
}
/** 로컬 표시를 연결·주체·관점·실행별로 나눕니다. */
function keyFor(session: QuestionSession, runId: string): string {
  return JSON.stringify([session.connectionId, session.expectedScope, runId]);
}
/** 연결 변경 시 이전 자료를 공개하지 않는 고정 오류입니다. */
function changed(): ApiFailure {
  return apiFailure(
    'scope_changed',
    '연결·작업 공간·관점이 바뀌었습니다. 원래 범위에서 다시 확인해 주세요.',
  );
}
/** 질문의 명시 실행·서버 영수증 조회와 개인 CLI 수명만 관리합니다. */
export class QuestionRunService {
  #connection: QuestionConnection;
  #recovery: ProcessRecovery | undefined;
  #runtime: () => Promise<QuestionRuntime>;
  #running: Running | null = null;
  #starting = false;
  #epoch = 0;
  #startSettled: Promise<void> = Promise.resolve();
  #finishStart: (() => void) | undefined;
  #local = new Map<string, QuestionLocal>();
  #requests = new Set<AbortController>();

  /** 공통 연결을 재사용해 같은 창·주체의 요청만 처리합니다. */
  constructor(
    connection: QuestionConnection,
    runtime: () => Promise<QuestionRuntime> = defaultRuntime,
    recovery?: ProcessRecovery,
  ) {
    this.#connection = connection;
    this.#recovery = recovery;
    this.#runtime = runtime;
    connection.onScopeChanged((): void => {
      for (const request of this.#requests) request.abort();
      void this.stop();
      this.#local.clear();
    });
  }

  /** source_write 대신 서버의 conversation_write 검증을 사용하며 고정 UI 범위를 대조합니다. */
  async #context(
    session: QuestionSession,
  ): Promise<AnalysisContext | ApiFailure> {
    const context = await this.#connection.analysisContext(
      session.connectionId,
    );
    if ('ok' in context) return context;
    const scope = session.expectedScope;
    if (
      context.active.userId !== scope.userId ||
      context.active.policyRevision !== scope.policyRevision ||
      context.selection.tenant !== scope.tenant ||
      context.selection.profile !== scope.profileId
    )
      return changed();
    return context;
  }

  /** 관점은 모든 GET/POST에 고정하며 반환된 접근 범위도 재검사합니다. */
  async #api(
    context: AnalysisContext,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ReadApiResult> {
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    const query = new URLSearchParams({ profile: context.selection.profile });
    const url = `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/${path}`;
    const controller = new AbortController();
    this.#requests.add(controller);
    const result = await readApiJson(
      body ? url : `${url}${url.includes('?') ? '&' : '?'}${query.toString()}`,
      context.token,
      controller,
      {
        maxResponseBytes: 16 * 1024 * 1024,
        ...(body
          ? {
              method: 'POST',
              body: { ...body, profile: context.selection.profile },
            }
          : {}),
      },
    );
    this.#requests.delete(controller);
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    if (!result.ok) {
      this.#connection.analysisAccessFailure(result);
      return result;
    }
    const parsed = envelopeSchema.safeParse(result.value);
    if (!parsed.success)
      return apiFailure(
        'invalid_response',
        '질문 실행 응답의 형식을 확인할 수 없습니다.',
      );
    const scope = parsed.data.data.access;
    if (
      scope.user_id !== context.active.userId ||
      scope.tenant !== context.selection.tenant ||
      scope.profile_id !== context.selection.profile ||
      scope.policy_revision !== context.active.policyRevision
    )
      return changed();
    return { ok: true, value: parsed.data.data };
  }

  /** 실행 상태와 별도로 실제 영수증·대화 답변을 확인합니다. */
  async #detail(
    context: AnalysisContext,
    session: QuestionSession,
    runId: string,
  ): Promise<QuestionDetailResult> {
    const result = await this.#api(context, `question-runs/${runId}`);
    if (!result.ok) return result;
    try {
      await this.#restoreRun(context, session, runId);
      const detail = projectQuestion(result.value, session, runId);
      detail.local =
        this.#local.get(keyFor(session, runId)) ?? idleQuestionLocal();
      const requestId = detail.local.requestId;
      if (
        requestId &&
        !detail.receipts.some(
          (receipt: (typeof detail.receipts)[number]): boolean =>
            receipt.request_id === requestId,
        )
      ) {
        const receipt = await this.#api(
          context,
          `question-runs/${runId}/answers/${requestId}`,
        );
        if (receipt.ok) {
          const parsed = questionReceiptSchema.parse(receipt.value);
          if (
            parsed.record_id !== runId ||
            parsed.request_id !== requestId ||
            (parsed.receipt &&
              (parsed.receipt.question_run_id !== runId ||
                parsed.receipt.conversation_id !== detail.conversationId ||
                parsed.receipt.basis_snapshot_revision !==
                  detail.basisRevision))
          )
            throw new Error('receipt_mismatch');
          detail.receipts.push(parsed);
        } else
          detail.answerReadError =
            '마지막 답변 요청의 저장 영수증을 확인하지 못했습니다. 다시 실행하지 말고 조회해 주세요.';
      }
      if (
        detail.receipts.some(
          (receipt: (typeof detail.receipts)[number]): boolean =>
            receipt.saved === true,
        )
      ) {
        const conversation = await this.#api(
          context,
          `conversations/${detail.conversationId}`,
        );
        if (conversation.ok)
          detail.answers = projectQuestionAnswers(
            conversation.value,
            detail,
            session,
          );
        else
          detail.answerReadError =
            '저장 영수증은 확인했지만 답변 본문을 읽지 못했습니다. 다시 조회해 주세요.';
      }
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (
        !this.#running &&
        detail.receipts.some(
          (receipt: (typeof detail.receipts)[number]): boolean =>
            receipt.saved === true,
        )
      ) {
        try {
          const entries = await readProcessJournal(
            this.#recovery,
            context,
            'pending-question-run',
          );
          const entry =
            entries.find(
              (value: RecoveryEntry): boolean => value.key === `run:${runId}`,
            ) ?? null;
          await removeProcessJournal(this.#recovery, context, entry);
        } catch {
          detail.local = { ...detail.local, cleanupWarning: true };
        }
      }
      return { ok: true, data: detail };
    } catch {
      return apiFailure(
        'invalid_response',
        '질문 상태·근거·저장 답변을 확인할 수 없습니다. 다시 조회해 주세요.',
      );
    }
  }

  /** 목록 조회로 프로세스를 만들지 않습니다. */
  async list(request: QuestionListRequest): Promise<QuestionPageResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const query = new URLSearchParams({ limit: '20' });
    if (request.cursor) query.set('cursor', request.cursor);
    const result = await this.#api(
      context,
      `question-runs?${query.toString()}`,
    );
    if (!result.ok) return result;
    const page = pageSchema.safeParse(result.value);
    return page.success
      ? {
          ok: true,
          data: {
            items: page.data.items,
            nextCursor: page.data.next_cursor,
            incomplete:
              !page.data.complete ||
              page.data.truncated ||
              page.data.skipped.length > 0,
          },
        }
      : apiFailure('invalid_response', '질문 실행 목록을 확인할 수 없습니다.');
  }

  /** 재시작 뒤 실행 ID·마지막 저장 요청만 복원하고 서버의 영수증을 다시 읽습니다. */
  async #restoreRun(
    context: AnalysisContext,
    session: QuestionSession,
    runId: string,
  ): Promise<void> {
    const key = keyFor(session, runId);
    if (this.#local.has(key)) return;
    const entries = await readProcessJournal(
      this.#recovery,
      context,
      'pending-question-run',
    );
    const entry = entries.find(
      (value: RecoveryEntry): boolean => value.key === `run:${runId}`,
    );
    if (!entry) return;
    const value = z
      .object({
        operation: z.literal('run'),
        runId: id,
        requestId: id.nullable(),
      })
      .parse(JSON.parse(entry.payload));
    if (value.runId !== runId) throw new Error('recovery_mismatch');
    this.#local.set(key, {
      ...idleQuestionLocal(),
      status: 'exited',
      phase: 'receipt-check',
      requestId: value.requestId,
    });
  }

  /** 과거 실행을 여는 것은 읽기이며 AI를 재시작하지 않습니다. */
  async read(request: QuestionReadRequest): Promise<QuestionDetailResult> {
    const context = await this.#context(request);
    return 'ok' in context
      ? context
      : this.#detail(context, request, request.questionRunId);
  }

  /** 저장된 질문과 현재 대화 판본으로 실행 자원을 한 번 접수합니다. */
  async create(request: QuestionCreateRequest): Promise<QuestionDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    try {
      const entries = await readProcessJournal(
        this.#recovery,
        context,
        'pending-question-run',
      );
      if (
        !entries.some(
          (entry: RecoveryEntry): boolean =>
            entry.key === `create:${request.requestId}`,
        )
      )
        await writeProcessJournal(
          this.#recovery,
          context,
          'pending-question-run',
          `create:${request.requestId}`,
          {
            operation: 'create',
            requestId: request.requestId,
            conversationId: request.conversationId,
            questionTurnId: request.questionTurnId,
            conversationRevision: request.conversationRevision,
          },
        );
    } catch {
      return apiFailure(
        'recovery_unavailable',
        '질문 접수 ID를 보호 저장하지 못했습니다. 접수를 시작하지 않았습니다.',
      );
    }
    const result = await this.#api(context, 'question-runs', {
      request_id: request.requestId,
      conversation_id: request.conversationId,
      question_turn_id: request.questionTurnId,
      expected_conversation_revision: request.conversationRevision,
    });
    if (!result.ok) return result;
    try {
      const detail = projectQuestion(result.value, request);
      if (
        detail.conversationId !== request.conversationId ||
        detail.questionTurnId !== request.questionTurnId
      )
        throw new Error('mismatch');
      return this.creationReceipt(request);
    } catch {
      return apiFailure(
        'outcome_unknown',
        '질문 접수 결과가 미확인입니다. 동일 요청의 접수 기록을 조회해 주세요.',
      );
    }
  }

  /** 응답 유실 뒤에는 동일 생성 영수증만 읽으며 자동 실행하지 않습니다. */
  async creationReceipt(
    request: QuestionCreationReceiptRequest,
  ): Promise<QuestionDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#api(
      context,
      `personal-requests/question-runs/${request.requestId}`,
    );
    if (!result.ok) return result;
    const receipt = z
      .object({
        request_confirmed: z.literal(true),
        request_id: id,
        record: z.object({
          id,
          kind: z.literal('question-runs'),
          requests: z.record(z.string(), z.string()),
        }),
      })
      .safeParse(result.value);
    if (
      !receipt.success ||
      receipt.data.request_id !== request.requestId ||
      !receipt.data.record.requests[request.requestId]
    )
      return apiFailure(
        'outcome_unknown',
        '같은 접수 요청을 아직 확인하지 못했습니다. 새 요청을 만들지 마세요.',
      );
    const detail = await this.#detail(context, request, receipt.data.record.id);
    if (detail.ok) {
      try {
        const entries = await readProcessJournal(
          this.#recovery,
          context,
          'pending-question-run',
        );
        const entry =
          entries.find(
            (value: RecoveryEntry): boolean =>
              value.key === `create:${request.requestId}`,
          ) ?? null;
        await removeProcessJournal(this.#recovery, context, entry);
      } catch {
        detail.data.local = { ...detail.data.local, cleanupWarning: true };
      }
    }
    return detail;
  }

  /** 이미 읽은 실행 판본을 확인한 명시 동작에서만 선택한 개인 AI를 시작합니다. */
  async start(request: QuestionStartRequest): Promise<QuestionDetailResult> {
    if (this.#starting || this.#running)
      return apiFailure(
        'question_busy',
        '이 앱에서 질문을 실행 중입니다. 현재 실행을 먼저 확인해 주세요.',
      );
    this.#starting = true;
    const epoch = this.#epoch;
    this.#startSettled = new Promise<void>((done: () => void): void => {
      this.#finishStart = done;
    });
    try {
      const context = await this.#context(request);
      if ('ok' in context) return context;
      const detail = await this.#detail(
        context,
        request,
        request.questionRunId,
      );
      if (!detail.ok) return detail;
      if (detail.data.stateRevision !== request.expectedStateRevision)
        return apiFailure(
          'conflict',
          '실행 기준이 바뀌었습니다. 현재 상태를 확인한 뒤 다시 선택해 주세요.',
          409,
        );
      if (
        detail.data.receipts.length ||
        detail.data.local.requestId ||
        detail.data.local.phase === 'receipt-check' ||
        !(
          detail.data.status === 'queued' ||
          (detail.data.status === 'running' &&
            detail.data.leaseStatus === 'expired' &&
            request.reclaim)
        )
      )
        return apiFailure(
          'question_not_startable',
          '이미 실행 중이거나 답변 저장을 확인해야 하는 질문입니다. 서버 상태를 조회해 주세요.',
        );
      const runtime = await this.#runtime();
      await assertPersonalRuntime(runtime);
      await this.#spawn(context, request, runtime, epoch);
      return this.#detail(context, request, request.questionRunId);
    } catch {
      return apiFailure(
        process.platform === 'win32'
          ? 'unsupported_platform'
          : 'question_start_failed',
        process.platform === 'win32'
          ? 'Windows 개인 실행 환경의 파일 보호·프로세스 종료 진단에 실패했습니다. Python·pywin32 설치와 실행 경로를 확인해 주세요. 기존 질문과 영수증은 조회할 수 있습니다.'
          : '개인 질문 실행기를 시작하지 못했습니다. Python·선택한 AI CLI 설치와 보호 저장 설정을 확인해 주세요.',
      );
    } finally {
      this.#starting = false;
      this.#finishStart?.();
      this.#finishStart = undefined;
    }
  }

  /** 취소 CAS 실패도 성공으로 바꾸지 않고 로컬 생성만 별도로 중단합니다. */
  async cancel(request: QuestionCancelRequest): Promise<QuestionDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#api(
      context,
      `question-runs/${request.questionRunId}/cancel`,
      {
        request_id: request.requestId,
        expected_state_revision: request.expectedStateRevision,
      },
    );
    if (this.#running?.key === keyFor(request, request.questionRunId))
      await this.stop();
    if (!result.ok) return result;
    return this.#detail(context, request, request.questionRunId);
  }

  /** 창 닫기·연결 변경은 같은 Python 프로세스에 협력 취소를 전달합니다. */
  async stop(): Promise<void> {
    this.#epoch += 1;
    await this.#startSettled;
    const running = this.#running;
    if (!running) return;
    if (!running.stopping) {
      running.stopping = true;
      const local = this.#local.get(running.key);
      if (local) this.#local.set(running.key, { ...local, status: 'stopping' });
    }
    await stopPersonalProcess(running.child, running.closed);
  }

  /** 인증 파일은 main만 만들고 CLI 출력에서 경로·원본·실행 지문을 renderer에 전달하지 않습니다. */
  async #spawn(
    context: AnalysisContext,
    request: QuestionStartRequest,
    runtime: QuestionRuntime,
    epoch: number,
  ): Promise<void> {
    const execution = await createPrivateExecution(
      runtime,
      runtime.privateRoot,
      context.token,
    );
    let journal: RecoveryEntry | null = null;
    let journalWrites: Promise<void> = Promise.resolve();
    let child: ChildProcess;
    try {
      journal = await writeProcessJournal(
        this.#recovery,
        context,
        'pending-question-run',
        `run:${request.questionRunId}`,
        {
          operation: 'run',
          runId: request.questionRunId,
          stateRevision: request.expectedStateRevision,
          requestId: null,
        },
      );
      if (epoch !== this.#epoch || !this.#connection.isAnalysisCurrent(context))
        throw new Error('scope_changed');
      child = spawnPersonalProcess(runtime, [
        '-B',
        '-m',
        'tools.question_cli',
        '--server',
        context.active.serverUrl.replace(/\/api\/v1\/$/, ''),
        '--tenant',
        context.selection.tenant,
        '--profile',
        context.selection.profile,
        '--question-run-id',
        request.questionRunId,
        '--token-file',
        execution.tokenFile,
        '--work-dir',
        execution.workDirectory,
        '--run-ai',
        '--ai-provider',
        runtime.ai.provider,
        '--ai-cli',
        runtime.ai.cli,
        ...(request.reclaim ? ['--reclaim'] : []),
      ]);
    } catch {
      await execution.cleanupAuth();
      throw new Error('question_spawn_failed');
    }
    const key = keyFor(request, request.questionRunId);
    this.#local.set(key, {
      ...idleQuestionLocal(),
      status: 'running',
      phase: 'starting',
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let discard = false;
    child.stdout?.on('data', (chunk: Buffer): void => {
      buffer += decoder.write(chunk);
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!discard && line.length <= 1024 * 1024) {
          try {
            const local = this.#local.get(key);
            if (local && this.#connection.isAnalysisCurrent(context)) {
              const next = applyQuestionCliEvent(
                local,
                JSON.parse(line),
                request.questionRunId,
              );
              if (next.requestId && next.requestId !== local.requestId) {
                journalWrites = journalWrites
                  .then(async (): Promise<void> => {
                    if (journal)
                      journal = await writeProcessJournal(
                        this.#recovery,
                        context,
                        'pending-question-run',
                        journal.key,
                        {
                          operation: 'run',
                          runId: request.questionRunId,
                          stateRevision: request.expectedStateRevision,
                          requestId: next.requestId,
                        },
                        journal.revision,
                      );
                  })
                  .catch((): void => {
                    const latest = this.#local.get(key);
                    if (latest)
                      this.#local.set(key, { ...latest, cleanupWarning: true });
                    void this.stop();
                  });
              }
              this.#local.set(key, {
                ...next,
                preview: next.preview.replaceAll(
                  context.token,
                  '[인증정보 비공개]',
                ),
              });
            }
          } catch {
            /* 잘못된 한 줄을 원문 오류로 공개하지 않습니다. */
          }
        }
        discard = false;
      }
      if (buffer.length > 1024 * 1024) {
        buffer = '';
        discard = true;
      }
    });
    child.stderr?.resume();
    child.stdin?.on('error', (): void => {
      /* 종료된 프로세스의 취소 입력은 무시합니다. */
    });
    const running: Running = {
      child,
      key,
      closed: Promise.resolve(),
      stopping: false,
    };
    running.closed = new Promise<void>((done: () => void): void => {
      child.on('error', (): void => {
        const local = this.#local.get(key);
        if (local)
          this.#local.set(key, {
            ...local,
            status: 'failed',
            errorCode: 'question_cli_unavailable',
          });
      });
      child.on('close', (code: number | null): void => {
        const local = this.#local.get(key);
        if (local)
          this.#local.set(key, {
            ...local,
            status: code === 0 || running.stopping ? 'exited' : 'failed',
          });
        void journalWrites
          .then((): Promise<void> => execution.cleanupAuth())
          .catch((): void => {
            const latest = this.#local.get(key);
            if (latest)
              this.#local.set(key, { ...latest, cleanupWarning: true });
          })
          .finally((): void => {
            if (this.#running === running) this.#running = null;
            done();
          });
      });
    });
    this.#running = running;
  }
}
