import { matchesExpectedScope } from './readApi';
import { ExecutionStarts } from './ExecutionStarts';
import type { AiActivity } from '@contracts/aiSessions.contract';
import { aiModelArguments, personalAi } from './personalAi';
import type { PersonalAi } from './personalAi';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import {
  proposalExecutionStartSchema,
  proposalExecutionReadSchema,
} from '@contracts/proposalExecution.contract';
import type {
  ProposalExecutionStart,
  ProposalExecutionRead,
  ProposalExecutionCancel,
  ProposalExecutionResult,
  ProposalExecutionLocal,
} from '@contracts/proposalExecution.contract';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import type { AnalysisProposalsApi } from './AnalysisProposalsApi';
import type { RecoveryService } from './RecoveryService';
import {
  createPrivateExecution,
  spawnPersonalProcess,
  personalRuntimePaths,
  observePersonalProcess,
  stopPersonalProcess,
} from './personalProcess';

export type ProposalRuntime = {
  projectRoot: string;
  python: string;
  ai: PersonalAi;
  privateRoot: string;
};
type ProposalConnection = Pick<
  ConnectionService,
  'analysisContext' | 'isAnalysisCurrent' | 'onScopeChanged'
>;
type Running = {
  child: ChildProcess;
  closed: Promise<void>;
  key: string;
  stopping: boolean;
  activity: AiActivity;
  context: AnalysisContext;
};
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const executionSchema = z.object({
  proposal_id: id,
  execution_id: id,
  job_id: id.nullable().optional(),
  job_revision: revision.nullable().optional(),
  canonical_changed: z.literal(false),
  state: z.string(),
});

/** 실행 경로는 renderer 입력 대신 설치된 개인 실행기 설정에서만 선택합니다. */
async function defaultRuntime(): Promise<ProposalRuntime> {
  const { app } = await import('electron');
  const { projectRoot, python } = personalRuntimePaths();
  const ai = await personalAi('proposal');
  await access(python);
  await access(join(projectRoot, 'tools/proposal_cli.py'));
  return {
    projectRoot,
    python,
    ai,
    privateRoot: join(app.getPath('userData'), 'proposals'),
  };
}
/** 로컬 표시를 실행·연결·현재 권한 범위로 분리합니다. */
function keyFor(request: ProposalExecutionRead): string {
  return JSON.stringify([
    request.connectionId,
    request.expectedScope,
    request.proposalId,
    request.executionId,
  ]);
}
/** 저장 여부는 서버 영수증에서만 확인하며 로컬 기본값에 성공을 넣지 않습니다. */
export function idleProposalLocal(): ProposalExecutionLocal {
  return {
    status: 'idle',
    phase: 'not_started',
    errorCode: null,
    requestId: null,
    preview: '',
    previewTruncated: false,
    cleanupWarning: false,
  };
}
/** 안전한 고정 오류만 반환하고 CLI stderr·인증정보를 노출하지 않습니다. */
function failure(
  code: string,
  message: string,
  executionId?: string,
): ProposalExecutionResult {
  return {
    ok: false,
    error: { code, message, ...(executionId ? { executionId } : {}) },
  };
}
/** 허용된 진행 상태만 표시하며 CLI의 saved 보고는 서버 저장 근거로 쓰지 않습니다. */
export function applyProposalCliEvent(
  local: ProposalExecutionLocal,
  value: unknown,
  executionId: string,
): ProposalExecutionLocal {
  const event = z
    .object({
      protocol: z.literal('proposal-cli-v1'),
      type: z.enum(['progress', 'candidate_preview', 'result']),
      execution_id: id.nullish(),
      phase: z
        .string()
        .regex(/^[a-z0-9_:-]{1,128}$/)
        .optional(),
      request_id: id.nullish(),
      status: z
        .string()
        .regex(/^[a-z0-9_]{1,128}$/)
        .optional(),
      truncated: z.boolean().optional(),
      error: z
        .object({ code: z.string().regex(/^[a-z0-9_]{1,128}$/) })
        .nullable()
        .optional(),
      text: z.string().optional(),
      error_code: z
        .string()
        .regex(/^[a-z0-9_]{1,128}$/)
        .optional(),
    })
    .safeParse(value);
  if (
    !event.success ||
    (event.data.execution_id && event.data.execution_id !== executionId)
  )
    return local;
  const data = event.data;
  const preview =
    data.type === 'candidate_preview' && data.text ? data.text : local.preview;
  return {
    ...local,
    phase: data.phase ?? data.status ?? local.phase,
    requestId: data.request_id ?? local.requestId,
    errorCode: data.error_code ?? data.error?.code ?? local.errorCode,
    preview: preview.slice(0, 65536),
    previewTruncated:
      local.previewTruncated || !!data.truncated || preview.length > 65536,
  };
}
/** 후보 전용 실행을 접수하고 개인 CLI의 수명과 실제 서버 기록을 각각 관리합니다. */
export class ProposalExecutionService {
  #connection: ProposalConnection;
  #api: Pick<AnalysisProposalsApi, 'execute'>;
  #runtime: () => Promise<ProposalRuntime>;
  #recovery: Pick<RecoveryService, 'capture'> | undefined;
  #local = new Map<string, ProposalExecutionLocal>();
  #running = new Map<string, Running>();
  #starts = new ExecutionStarts();
  #epoch = 0;
  constructor(
    connection: ProposalConnection,
    proposals: Pick<AnalysisProposalsApi, 'execute'>,
    runtime: () => Promise<ProposalRuntime> = defaultRuntime,
    recovery?: Pick<RecoveryService, 'capture'>,
  ) {
    this.#connection = connection;
    this.#api = proposals;
    this.#runtime = runtime;
    this.#recovery = recovery;
    connection.onScopeChanged((): void => {
      void this.shutdown();
      this.#local.clear();
    });
  }
  /** 현재 인증과 UI가 읽은 범위를 다시 확인합니다. */
  async #context(
    request: ProposalExecutionRead | ProposalExecutionStart,
  ): Promise<AnalysisContext | ProposalExecutionResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    if (!matchesExpectedScope(request.expectedScope, context))
      return failure(
        'scope_changed',
        '연결 또는 작업 공간의 조회 설정이 바뀌었습니다. 이전 기록을 보존하고 현재 작업 공간에서 다시 확인해 주세요.',
      );
    return context;
  }
  /** 읽기만으로 종료 후 실행과 후보 영수증을 재발견합니다. */
  async read(value: ProposalExecutionRead): Promise<ProposalExecutionResult> {
    const parsed = proposalExecutionReadSchema.safeParse(value);
    if (!parsed.success)
      return failure('invalid_request', '추출 결과·실행 ID를 확인해 주세요.');
    const request = parsed.data;
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#api.execute({
      connectionId: request.connectionId,
      expectedScope: request.expectedScope,
      operation: 'execution-read',
      input: {
        proposal_id: request.proposalId,
        execution_id: request.executionId,
      },
    });
    if (!result.ok)
      return {
        ok: false,
        error: { ...result.error, executionId: request.executionId },
      };
    const receipt = executionSchema.safeParse(result.data);
    if (
      !receipt.success ||
      receipt.data.proposal_id !== request.proposalId ||
      receipt.data.execution_id !== request.executionId ||
      !this.#connection.isAnalysisCurrent(context)
    )
      return failure(
        'invalid_response',
        '실행 기록의 식별·권한 범위를 확인하지 못했습니다.',
        request.executionId,
      );
    const local = this.#local.get(keyFor(request)) ?? idleProposalLocal();
    let server = result.data;
    if (local.requestId) {
      const receiptResult = await this.#api.execute({
        connectionId: request.connectionId,
        expectedScope: request.expectedScope,
        operation: 'receipt',
        input: { proposal_id: request.proposalId, request_id: local.requestId },
      });
      if (
        receiptResult.ok &&
        receiptResult.data.proposal_id === request.proposalId &&
        receiptResult.data.execution_id === request.executionId &&
        receiptResult.data.request_id === local.requestId &&
        receiptResult.data.canonical_changed === false
      )
        server = { ...server, latest_candidate_receipt: receiptResult.data };
      if (!this.#connection.isAnalysisCurrent(context))
        return failure(
          'scope_changed',
          '연결 범위가 바뀌어 실행 결과를 숨겼습니다.',
          request.executionId,
        );
    }
    return {
      ok: true,
      data: {
        proposalId: request.proposalId,
        executionId: request.executionId,
        server,
        local,
      },
    };
  }
  /** 요청 ID를 보호 저장한 뒤 서버 접수와 개인 AI 실행을 각각 한 번 수행합니다. */
  async start(value: ProposalExecutionStart): Promise<ProposalExecutionResult> {
    const parsed = proposalExecutionStartSchema.safeParse(value);
    if (!parsed.success)
      return failure('invalid_request', '현재 추출 결과 기준을 확인해 주세요.');
    const request = parsed.data;
    const startKey = keyFor({ ...request, executionId: request.requestId });
    const finish = this.#running.has(startKey)
      ? null
      : this.#starts.begin(startKey);
    if (!finish)
      return failure(
        'execution_busy',
        '개인 추출 결과을 실행 중입니다. 현재 실행을 확인해 주세요.',
      );
    const epoch = this.#epoch;
    let attempted = false;
    try {
      const context = await this.#context(request);
      if ('ok' in context) return context;
      const runtime = await this.#runtime();
      if (!this.#recovery)
        return failure(
          'recovery_unavailable',
          '종료 후 요청을 확인할 보호 저장을 먼저 연결해 주세요. AI를 시작하지 않았습니다.',
        );
      if (this.#recovery) {
        const journal = await this.#recovery.capture(
          context,
          'pending-analysis',
          `proposal-${request.requestId}`,
          JSON.stringify({ kind: 'proposal-execution', request }),
          null,
        );
        if (!journal.ok) return journal;
      }
      attempted = true;
      const result = await this.#api.execute({
        connectionId: request.connectionId,
        expectedScope: request.expectedScope,
        operation: 'execution-create',
        input: {
          proposal_id: request.proposalId,
          request_id: request.requestId,
          expected_state_revision: request.expectedStateRevision,
          candidate_revision: request.candidateRevision,
          reason:
            '사용자가 현재 고정 원문·규약으로 새 AI 후보 생성을 명시 요청함',
        },
      });
      if (!result.ok)
        return {
          ok: false,
          error: { ...result.error, executionId: request.requestId },
        };
      const receipt = executionSchema.safeParse(result.data);
      if (
        !receipt.success ||
        receipt.data.proposal_id !== request.proposalId ||
        receipt.data.execution_id !== request.requestId ||
        receipt.data.state !== 'ready'
      )
        return failure(
          'outcome_unknown',
          '실행 접수 상태를 확인해 주세요. AI를 시작하지 않았습니다.',
          request.requestId,
        );
      if (!this.#connection.isAnalysisCurrent(context))
        return failure(
          'scope_changed',
          '연결 범위가 바뀌어 AI를 시작하지 않았습니다.',
          request.requestId,
        );
      await this.#spawn(context, request, runtime, epoch);
      return this.read({
        connectionId: request.connectionId,
        expectedScope: request.expectedScope,
        proposalId: request.proposalId,
        executionId: request.requestId,
      });
    } catch {
      return failure(
        'execution_start_failed',
        '개인 실행기를 시작하지 못했습니다. 설치·보호 저장과 같은 실행 기록을 확인해 주세요.',
        attempted ? request.requestId : undefined,
      );
    } finally {
      finish();
    }
  }
  /** 현재 실행의 서버 CAS 취소와 로컬 프로세스 중단을 각각 확인합니다. */
  async cancel(
    value: ProposalExecutionCancel,
  ): Promise<ProposalExecutionResult> {
    const parsed = proposalExecutionReadSchema.safeParse(value);
    if (!parsed.success)
      return failure('invalid_request', '중단할 실행 ID를 확인해 주세요.');
    const request = parsed.data;
    const detail = await this.read(request);
    if (!detail.ok) {
      await this.#stopOne(keyFor(request));
      return detail;
    }
    const execution = executionSchema.safeParse(detail.data.server);
    if (
      !execution.success ||
      !execution.data.job_id ||
      !execution.data.job_revision
    )
      return failure(
        'outcome_unknown',
        '로컬 실행 중단 뒤 서버 작업을 확인하지 못했습니다. 같은 기록을 조회해 주세요.',
        request.executionId,
      );
    const result = await this.#api.execute({
      connectionId: request.connectionId,
      expectedScope: request.expectedScope,
      operation: 'execution-cancel',
      input: {
        proposal_id: request.proposalId,
        job_id: execution.data.job_id,
        expected_job_revision: execution.data.job_revision,
        reason: '사용자가 추출 결과 AI 실행 중단을 요청함',
      },
    });
    await this.#stopOne(keyFor(request));
    if (!result.ok)
      return {
        ok: false,
        error: { ...result.error, executionId: request.executionId },
      };
    return this.read(request);
  }
  /** 연결 변경·명시 종료는 접수 중인 작업과 모든 프로세스를 정리합니다. */
  async shutdown(): Promise<void> {
    this.#epoch += 1;
    await this.#starts.settled();
    await Promise.all(
      [...this.#running.keys()].map((key: string): Promise<void> =>
        this.#stopOne(key),
      ),
    );
  }

  /** 선택한 추출 결과 실행만 중단합니다. */
  async #stopOne(key: string): Promise<void> {
    const running = this.#running.get(key);
    if (!running) return;
    running.stopping = true;
    const local = this.#local.get(key);
    if (local) this.#local.set(key, { ...local, status: 'stopping' });
    await stopPersonalProcess(running.child, running.closed);
  }

  /** 공개 활동에는 인증정보나 원문을 포함하지 않습니다. */
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

  /** 접수 중인 작업도 종료 확인에 포함합니다. */
  get activeCount(): number {
    return this.#running.size + this.#starts.size;
  }

  /** 고정 모듈과 인자 배열만 실행하고 제한된 JSONL 이벤트만 읽습니다. */
  async #spawn(
    context: AnalysisContext,
    request: ProposalExecutionStart,
    runtime: ProposalRuntime,
    epoch: number,
  ): Promise<void> {
    const execution = await createPrivateExecution(
      runtime,
      runtime.privateRoot,
      context.token,
    );
    let child: ChildProcess;
    try {
      if (epoch !== this.#epoch || !this.#connection.isAnalysisCurrent(context))
        throw new Error('scope_changed');
      child = spawnPersonalProcess(runtime, [
        '-B',
        '-m',
        'tools.proposal_cli',
        '--server',
        context.active.serverUrl.replace(/\/api\/v1\/$/, ''),
        '--tenant',
        context.selection.tenant,
        '--profile',
        context.selection.profile,
        '--proposal-id',
        request.proposalId,
        '--execution-id',
        request.requestId,
        '--token-file',
        execution.tokenFile,
        '--work-dir',
        execution.workDirectory,
        '--run-ai',
        '--ai-provider',
        runtime.ai.provider,
        '--ai-cli',
        runtime.ai.cli,
        ...aiModelArguments(runtime.ai),
        ...(request.semanticCheck ? ['--semantic-check'] : []),
      ]);
    } catch (error: unknown) {
      await execution.cleanupAuth();
      throw error;
    }
    const key = keyFor({ ...request, executionId: request.requestId });
    this.#local.set(key, {
      ...idleProposalLocal(),
      status: 'running',
      phase: 'starting',
    });
    const running: Running = {
      context,
      child,
      key,
      stopping: false,
      activity: {
        kind: 'proposal',
        id: request.requestId,
        connectionId: request.connectionId,
        status: 'running',
        startedAt: new Date().toISOString(),
        proposalId: request.proposalId,
      },
      closed: Promise.resolve(),
    };
    running.closed = observePersonalProcess(child, {
      onEvent: (value: unknown): void => {
        const local = this.#local.get(key);
        if (!local || !this.#connection.isAnalysisCurrent(context)) return;
        const next = applyProposalCliEvent(local, value, request.requestId);
        this.#local.set(key, {
          ...next,
          preview: next.preview.replaceAll(context.token, '[인증정보 비공개]'),
        });
      },
      onError: (): void => {
        const local = this.#local.get(key);
        if (local)
          this.#local.set(key, {
            ...local,
            status: 'failed',
            errorCode: 'proposal_cli_unavailable',
          });
      },
      onClose: (code: number | null): void => {
        const local = this.#local.get(key);
        if (local)
          this.#local.set(key, {
            ...local,
            status: code === 0 || running.stopping ? 'exited' : 'failed',
          });
      },
      cleanup: (): Promise<void> => execution.cleanupAuth(),
      onCleanupError: (): void => {
        const latest = this.#local.get(key);
        if (latest) this.#local.set(key, { ...latest, cleanupWarning: true });
      },
      onFinished: (): void => {
        if (this.#running.get(key) === running) this.#running.delete(key);
      },
    });
    this.#running.set(key, running);
  }
}
