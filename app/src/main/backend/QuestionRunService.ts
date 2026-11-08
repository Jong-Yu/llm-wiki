import { ExecutionStarts } from './ExecutionStarts';
import { researchPublicWeb } from './webResearch';
import type { AiActivity } from '@contracts/aiSessions.contract';
import { aiModelArguments, personalAi } from './personalAi';
import type { PersonalAi } from './personalAi';
import type { ChildProcess } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import { apiFailure, readScopedApiJson, matchesExpectedScope } from './readApi';
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
  personalRuntimePaths,
  observePersonalProcess,
  runPersonalCommand,
  stopPersonalProcess,
} from './personalProcess';
import type { PrivateExecution } from './personalProcess';
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
  QuestionResumableRequest,
  QuestionResumableResult,
  QuestionSearchTermsRequest,
  QuestionSearchTermsResult,
  QuestionWebSearchRequest,
  QuestionWebSearchResult,
} from '@contracts/questionRuns.contract';
import {
  parseQuestionSearchTermsResult,
  questionReceiptSchema,
} from '@contracts/questionRuns.contract';
import {
  projectQuestion,
  projectQuestionAnswers,
  idleQuestionLocal,
  applyQuestionCliEvent,
} from './questionRunProjection';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const pointerSchema = z.looseObject({
  version: z.literal(1),
  conversation_id: id,
  provider: z.enum(['codex', 'claude']),
  turns_seen: z.number().int().min(0),
});
const envelopeSchema = z.object({
  data: z.looseObject({
    access: z.object({
      user_id: z.string(),
      tenant: z.string(),
      profile_id: z.string(),
      policy_revision: z.string(),
      access_revision: z
        .string()
        .min(1)
        .nullish()
        .transform(
          (value: string | null | undefined): string | undefined =>
            value ?? undefined,
        ),
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
  activity: AiActivity;
  context: AnalysisContext;
};
export type QuestionRuntime = {
  projectRoot: string;
  python: string;
  ai: PersonalAi;
  privateRoot: string;
  /** AI 세션 기록과 이어가기 포인터를 두는 안정된 개인 폴더입니다. */
  sessionRoot: string;
};

/** renderer가 실행 경로·토큰을 정하지 못하도록 main의 설치 설정만 사용합니다. */
export async function defaultRuntime(): Promise<QuestionRuntime> {
  const { app } = await import('electron');
  const { projectRoot, python } = personalRuntimePaths();
  const ai = await personalAi('question');
  await access(python);
  await access(join(projectRoot, 'tools/question_cli.py'));
  return {
    projectRoot,
    python,
    ai,
    privateRoot: join(app.getPath('userData'), 'questions'),
    sessionRoot: join(app.getPath('userData'), 'question-sessions'),
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
    '연결 또는 작업 공간의 조회 설정이 바뀌었습니다. 이전 기록을 보존하고 현재 작업 공간에서 다시 확인해 주세요.',
  );
}
/** 질문의 명시 실행·서버 영수증 조회와 개인 CLI 수명만 관리합니다. */
export class QuestionRunService {
  #connection: QuestionConnection;
  #recovery: ProcessRecovery | undefined;
  #runtime: () => Promise<QuestionRuntime>;
  #running = new Map<string, Running>();
  #starts = new ExecutionStarts();
  #epoch = 0;
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
    if (!matchesExpectedScope(session.expectedScope, context)) return changed();
    return context;
  }

  /** 관점은 모든 GET/POST에 고정하며 반환된 접근 범위도 재검사합니다. */
  async #api(
    context: AnalysisContext,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ReadApiResult> {
    return readScopedApiJson(this.#connection, this.#requests, context, path, {
      body,
      schema: envelopeSchema,
      changed,
      profile: 'get-query',
      maxResponseBytes: 16 * 1024 * 1024,
      invalidMessage: '질문 실행 응답의 형식을 확인할 수 없습니다.',
    });
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
        !this.#running.has(keyFor(session, runId)) &&
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
    const key = keyFor(request, request.questionRunId);
    const finish = this.#running.has(key) ? null : this.#starts.begin(key);
    if (!finish)
      return apiFailure(
        'question_busy',
        '이 앱에서 질문을 실행 중입니다. 현재 실행을 먼저 확인해 주세요.',
      );
    const epoch = this.#epoch;
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
      await this.#spawn(
        context,
        request,
        runtime,
        epoch,
        detail.data.conversationId,
      );
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
      finish();
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
    await this.#stopOne(keyFor(request, request.questionRunId));
    if (!result.ok) return result;
    return this.#detail(context, request, request.questionRunId);
  }

  /** 계정·연결 변경과 명시 종료는 모든 실행을 정리합니다. */
  async stop(): Promise<void> {
    this.#epoch += 1;
    for (const request of this.#requests) request.abort();
    await this.#starts.settled();
    await Promise.all(
      [...this.#running.keys()].map((key: string): Promise<void> =>
        this.#stopOne(key),
      ),
    );
  }

  /** 한 질문의 중단은 다른 세션의 실행에 영향을 주지 않습니다. */
  async #stopOne(key: string): Promise<void> {
    const running = this.#running.get(key);
    if (!running) return;
    if (!running.stopping) {
      running.stopping = true;
      const local = this.#local.get(key);
      if (local) this.#local.set(key, { ...local, status: 'stopping' });
    }
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

  /**
   * 질문 문장만 선택한 AI에 보내 위키 검색어를 받아 옵니다. 위키 자료와 인증정보는 보내지 않으며,
   * 실패·취소·시간 초과는 오류가 아닌 빈 목록으로 돌려 호출자가 기존 검색으로 계속하게 합니다.
   */
  async searchTerms(
    request: QuestionSearchTermsRequest,
  ): Promise<QuestionSearchTermsResult> {
    const none: QuestionSearchTermsResult = { terms: [] };
    const abort = new AbortController();
    this.#requests.add(abort);
    let execution: PrivateExecution | null = null;
    try {
      const context = await this.#context(request);
      if ('ok' in context) return none;
      const runtime = await this.#runtime();
      await assertPersonalRuntime(runtime);
      await access(join(runtime.projectRoot, 'tools/search_terms_cli.py'));
      // 이 실행은 서버에 접속하지 않으므로 실제 토큰 대신 자리표시 값을 둡니다.
      execution = await createPrivateExecution(
        runtime,
        runtime.privateRoot,
        'unused',
      );
      const questionFile = join(execution.workDirectory, 'question.txt');
      await writeFile(questionFile, request.question, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (abort.signal.aborted) return none;
      const output = await runPersonalCommand(
        runtime,
        [
          '-B',
          '-m',
          'tools.search_terms_cli',
          '--work-dir',
          execution.workDirectory,
          '--question-file',
          questionFile,
          '--ai-provider',
          runtime.ai.provider,
          '--ai-cli',
          runtime.ai.cli,
          ...aiModelArguments(runtime.ai),
          '--ai-timeout',
          '30',
        ],
        { maxBytes: 65_536, timeoutMs: 40_000, signal: abort.signal },
      );
      if (abort.signal.aborted || output.timedOut || output.tooLarge)
        return none;
      const line = output.output.trim().split('\n').at(-1) ?? '';
      const parsed = z
        .object({
          protocol: z.literal('search-terms-cli-v1'),
          ok: z.literal(true),
          terms: z.array(z.string()),
        })
        .parse(JSON.parse(line));
      return parseQuestionSearchTermsResult({ terms: parsed.terms });
    } catch {
      return none;
    } finally {
      this.#requests.delete(abort);
      if (execution) {
        await execution.cleanupAuth().catch((): void => {});
        await rm(execution.directory, { recursive: true, force: true }).catch(
          (): void => {},
        );
      }
    }
  }

  /** 현재 접근 범위를 확인한 뒤 검색어만 별도 웹 조사에 전달합니다. */
  async webSearch(
    request: QuestionWebSearchRequest,
  ): Promise<QuestionWebSearchResult> {
    const context = await this.#context(request);
    if ('ok' in context) throw new Error('scope_changed');
    const abort = new AbortController();
    this.#requests.add(abort);
    try {
      const runtime = await this.#runtime();
      if (abort.signal.aborted || !this.#connection.isAnalysisCurrent(context))
        throw new Error('scope_changed');
      const result = await researchPublicWeb(
        runtime,
        request.query,
        abort.signal,
      );
      if (abort.signal.aborted || !this.#connection.isAnalysisCurrent(context))
        throw new Error('scope_changed');
      return result;
    } finally {
      this.#requests.delete(abort);
    }
  }

  /** 포인터 파일만 읽어 이어 갈 세션이 있는지 확인하며 어떤 실패도 false로 처리합니다. */
  async resumable(
    request: QuestionResumableRequest,
  ): Promise<QuestionResumableResult> {
    try {
      const runtime = await this.#runtime();
      const text = await readFile(
        join(
          runtime.sessionRoot,
          'pointers',
          `${request.conversationId}.${request.provider}.json`,
        ),
        'utf8',
      );
      const pointer = pointerSchema.parse(JSON.parse(text));
      return {
        resumable:
          pointer.provider === request.provider &&
          pointer.conversation_id === request.conversationId &&
          // 세션이 본 턴이 지금 앞선 턴 이하이면 모르는 턴만 이어 붙여 이어 갈 수 있다.
          pointer.turns_seen > 0 &&
          pointer.turns_seen <= request.precedingTurns,
      };
    } catch {
      return { resumable: false };
    }
  }

  /** 접수 중인 작업도 명시 종료 확인에 포함합니다. */
  get activeCount(): number {
    return this.#running.size + this.#starts.size;
  }

  /** 인증 파일은 main만 만들고 CLI 출력에서 경로·원본·실행 지문을 renderer에 전달하지 않습니다. */
  async #spawn(
    context: AnalysisContext,
    request: QuestionStartRequest,
    runtime: QuestionRuntime,
    epoch: number,
    conversationId: string,
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
        '--session-dir',
        runtime.sessionRoot,
        '--run-ai',
        '--ai-provider',
        runtime.ai.provider,
        '--ai-cli',
        runtime.ai.cli,
        ...aiModelArguments(runtime.ai),
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
    const running: Running = {
      context,
      child,
      key,
      closed: Promise.resolve(),
      stopping: false,
      activity: {
        kind: 'question',
        conversationId,
        id: request.questionRunId,
        connectionId: request.connectionId,
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    };
    running.closed = observePersonalProcess(child, {
      onEvent: (value: unknown): void => {
        const local = this.#local.get(key);
        if (!local || !this.#connection.isAnalysisCurrent(context)) return;
        const next = applyQuestionCliEvent(local, value, request.questionRunId);
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
          preview: next.preview.replaceAll(context.token, '[인증정보 비공개]'),
        });
      },
      onError: (): void => {
        const local = this.#local.get(key);
        if (local)
          this.#local.set(key, {
            ...local,
            status: 'failed',
            errorCode: 'question_cli_unavailable',
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
      cleanup: async (): Promise<void> => {
        await journalWrites;
        await execution.cleanupAuth();
      },
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
