import { personalAi } from './personalAi';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import {
  analysisJobSchema,
  analysisReceiptSchema,
} from '@contracts/analysis.contract';
import type {
  AnalysisCancelRequest,
  AnalysisDetailResult,
  AnalysisDetail,
  AnalysisExecuteRequest,
  AnalysisExecutionInspectionResult,
  AnalysisJob,
  AnalysisListRequest,
  AnalysisLocal,
  AnalysisPageResult,
  AnalysisReadRequest,
  AnalysisReceipt,
  AnalysisStartRequest,
} from '@contracts/analysis.contract';
import type { ConnectionService } from './ConnectionService';
import type { AnalysisContext } from './ConnectionService';
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

const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  policy_revision: hash,
});
const envelopeSchema = z.object({
  data: z.looseObject({ access: accessSchema }),
  meta: z.object({ trace_id: identifier }),
});
const createdSchema = z.object({
  request_id: identifier,
  state: z.enum(['complete', 'pending_reconcile']),
  job_id: identifier,
});
const pageSchema = z.object({
  items: z.array(analysisJobSchema),
  next_cursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.unknown()),
  requires_refresh: z.boolean(),
});
type Running = {
  child: ChildProcess;
  context: AnalysisContext;
  jobId: string;
  closed: Promise<void>;
  stopping: boolean;
};
type Creation = {
  context: AnalysisContext;
  requestId: string;
  journal: RecoveryEntry | null;
};

/** 사용자 입력·원격 본문 대신 고정 안내만 공개합니다. */
function changed(): ApiFailure {
  return apiFailure(
    'connection_changed',
    '연결 또는 작업 공간이 변경되었습니다. 현재 선택을 다시 확인해 주세요.',
  );
}
/** 같은 작업이라도 연결·사용자·관점이 다르면 로컬 실행 표시를 섞지 않습니다. */
function runKey(context: AnalysisContext, jobId: string): string {
  return JSON.stringify([
    context.active.connectionId,
    context.active.serverUrl,
    context.active.policyRevision,
    context.active.userId,
    context.selection.tenant,
    context.selection.profile,
    jobId,
  ]);
}
/** 서버 API prefix를 제거해 기존 Python 클라이언트가 API/MCP 주소를 직접 조립하게 합니다. */
function serverBase(context: AnalysisContext): string {
  return context.active.serverUrl.replace(/\/api\/v1\/$/, '');
}
/** Electron은 기존 분석 CLI를 시작하고, 저장 사실은 서버에서 따로 읽습니다. */
export class AnalysisService {
  #connection: ConnectionService;
  #recovery: ProcessRecovery | undefined;
  #running: Running | null = null;
  #starting = false;
  #epoch = 0;
  #startSettled: Promise<void> = Promise.resolve();
  #finishStart: (() => void) | undefined;
  #local = new Map<string, AnalysisLocal>();
  #creation: Creation | null = null;
  #requests = new Set<AbortController>();

  /** 창·연결 수명과 프로세스 수명을 묶되 화면을 닫는 것만으로 새 실행을 만들지 않습니다. */
  constructor(connection: ConnectionService, recovery?: ProcessRecovery) {
    this.#recovery = recovery;
    this.#connection = connection;
    connection.onScopeChanged((): void => {
      for (const controller of this.#requests) controller.abort();
      void this.stop();
    });
  }

  /** 종료를 기다려 토큰 파일을 지운 뒤 앱을 닫을 수 있게 합니다. */
  async stop(): Promise<void> {
    this.#epoch += 1;
    await this.#startSettled;
    const running = this.#running;
    if (!running) return;
    if (!running.stopping) {
      running.stopping = true;
      this.#local.set(runKey(running.context, running.jobId), {
        status: 'stopped',
        message:
          '로컬 실행을 중단했습니다. 이미 저장한 결과는 서버에 보존됩니다.',
      });
    }
    await stopPersonalProcess(running.child, running.closed);
  }

  /** 같은 인증 범위에서만 요청하며 연결이 바뀐 뒤 도착한 응답은 버립니다. */
  async #api(
    context: AnalysisContext,
    path: string,
    body?: unknown,
  ): Promise<ReadApiResult> {
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    const controller = new AbortController();
    this.#requests.add(controller);
    const result = await readApiJson(
      `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/${path}`,
      context.token,
      controller,
      body === undefined ? {} : { method: 'POST', body },
    );
    this.#requests.delete(controller);
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    if (!result.ok) {
      this.#connection.analysisAccessFailure(result);
      return result;
    }
    try {
      const envelope = envelopeSchema.parse(result.value);
      const accessValue = envelope.data.access;
      // 작업 API는 서버 기본 관점으로 조회합니다. 선택 관점은 실제 CLI 입력에 따로 고정합니다.
      if (
        accessValue.user_id !== context.active.userId ||
        accessValue.tenant !== context.selection.tenant ||
        accessValue.policy_revision !== context.active.policyRevision
      ) {
        const failure = apiFailure(
          'scope_changed',
          '서버의 사용자·작업 공간·권한 기준이 변경되었습니다. 다시 연결해 주세요.',
        );
        this.#connection.analysisAccessFailure(failure);
        return failure;
      }
      return { ok: true, value: envelope.data };
    } catch {
      return apiFailure(
        'invalid_response',
        '서버의 분석 응답 형식을 확인할 수 없습니다.',
      );
    }
  }

  /** 서버가 반환한 작업의 소유권을 응답의 access와 별도로 확인합니다. */
  #job(value: unknown, context: AnalysisContext, jobId?: string): AnalysisJob {
    const job = analysisJobSchema.parse(value);
    if (
      job.tenant !== context.selection.tenant ||
      job.user_id !== context.active.userId ||
      (jobId !== undefined && job.job_id !== jobId)
    )
      throw new Error('scope_changed');
    return job;
  }

  /** 일부 목록만 읽었으면 다음 페이지/불완전 상태를 그대로 전달합니다. 조회는 실행이 아닙니다. */
  async list(request: AnalysisListRequest): Promise<AnalysisPageResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    try {
      await this.#restoreCreation(context);
    } catch {
      return apiFailure(
        'recovery_unavailable',
        '이전 분석 접수 기록을 복원하지 못했습니다. 보호 저장소를 확인해 주세요.',
      );
    }
    const query = new URLSearchParams({ limit: '20' });
    if (request.cursor !== null) query.set('cursor', request.cursor);
    const result = await this.#api(
      context,
      `analysis-jobs?${query.toString()}`,
    );
    if (!result.ok) return result;
    try {
      const page = pageSchema.parse(result.value);
      const jobs = page.items.map((value: AnalysisJob): AnalysisJob =>
        this.#job(value, context),
      );
      return {
        ok: true,
        data: {
          items: jobs.filter(
            (job: AnalysisJob): boolean =>
              request.sourceId === null ||
              job.source_ref.source_id === request.sourceId,
          ),
          nextCursor: page.next_cursor,
          complete: page.complete,
          truncated: page.truncated,
          skippedCount: page.skipped.length,
          requiresRefresh: page.requires_refresh,
        },
      };
    } catch {
      return apiFailure(
        'invalid_response',
        '분석 작업 목록을 확인할 수 없습니다.',
      );
    }
  }

  /** 현재 작업과 각 저장 영수증을 읽습니다. 실패한 영수증은 저장 실패로 바꾸지 않습니다. */
  async #detail(
    context: AnalysisContext,
    jobId: string,
  ): Promise<AnalysisDetailResult> {
    const result = await this.#api(context, `analysis-jobs/${jobId}`);
    if (!result.ok) return result;
    try {
      const job = this.#job(result.value, context, jobId);
      const receipts: AnalysisReceipt[] = [];
      const receiptErrors: { requestId: string; message: string }[] = [];
      for (const summary of job.result_summary.results) {
        const receipt = await this.#api(
          context,
          `analysis-jobs/${jobId}/results/${summary.request_id}`,
        );
        if (!receipt.ok) {
          if (!this.#connection.isAnalysisCurrent(context)) return changed();
          receiptErrors.push({
            requestId: summary.request_id,
            message: receipt.error.message,
          });
          continue;
        }
        try {
          const value = analysisReceiptSchema.parse(receipt.value);
          if (
            value.request_id !== summary.request_id ||
            (value.receipt !== null &&
              (value.receipt.document !== summary.document ||
                value.receipt.stage !== summary.stage))
          )
            throw new Error('invalid_response');
          receipts.push(value);
        } catch {
          receiptErrors.push({
            requestId: summary.request_id,
            message: '이 저장 영수증의 형식을 확인할 수 없습니다.',
          });
        }
      }
      return {
        ok: true,
        data: {
          job,
          receipts,
          receiptErrors,
          local: this.#local.get(runKey(context, jobId)) ?? {
            status: 'idle',
            message:
              '이 앱에서 실행 중인 프로세스가 없습니다. 서버 저장 상태를 표시합니다.',
          },
        },
      };
    } catch {
      return apiFailure(
        'invalid_response',
        '분석 작업 상태를 확인할 수 없습니다.',
      );
    }
  }

  /** 새 실행 없이 이미 저장된 작업과 결과만 확인합니다. */
  async read(request: AnalysisReadRequest): Promise<AnalysisDetailResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    return 'ok' in context ? context : this.#detail(context, request.jobId);
  }

  /** 실행 위치는 main 설정만 사용하며 읽기 화면은 Python 설치 없이도 열립니다. */
  async #runtime(): Promise<{ root: string; python: string } | ApiFailure> {
    const root = resolve(
      process.env.WIKI_CLIENT_ROOT ??
        process.env.WIKI_ANALYSIS_PROJECT_ROOT ??
        resolve(import.meta.dirname, '../../..'),
    );
    const python =
      process.env.WIKI_CLIENT_PYTHON ??
      process.env.WIKI_PYTHON ??
      process.env.WIKI_ANALYSIS_PYTHON ??
      join(
        root,
        process.platform === 'win32'
          ? '.venv/Scripts/python.exe'
          : '.venv/bin/python',
      );
    try {
      await access(python);
      await access(join(root, 'tools/analysis_cli.py'));
      await assertPersonalRuntime({ projectRoot: root, python });
      return { root, python };
    } catch {
      return apiFailure(
        process.platform === 'win32'
          ? 'unsupported_platform'
          : 'python_unavailable',
        process.platform === 'win32'
          ? 'Windows 개인 실행 환경의 파일 보호·프로세스 종료 진단에 실패했습니다. Python·pywin32 설치와 실행 경로를 확인해 주세요. 기존 결과는 조회할 수 있습니다.'
          : '개인 Python 분석 실행 환경을 찾을 수 없습니다. 실행 경로·설치를 확인해 주세요. 기존 결과는 조회할 수 있습니다.',
      );
    }
  }

  /** 현재 영수증·사용권으로만 실행 가능 여부를 안내하고 서버의 최종 검증을 대신하지 않습니다. */
  #executionBlockers(
    detail: AnalysisDetail,
    context: AnalysisContext,
  ): string[] {
    const { job, receipts, receiptErrors } = detail;
    const blockers: string[] = [];
    if (job.state === 'cancelled')
      blockers.push('서버에서 취소한 작업은 재개할 수 없습니다.');
    if (job.basis_status !== 'current')
      blockers.push(
        '원본 기준이 변경되었거나 사라졌습니다. 현재 원본으로 계획을 다시 확인해 주세요.',
      );
    if (job.result_summary.status === 'complete')
      blockers.push(
        '요청한 결과가 모두 저장되었습니다. 기존 영수증을 확인해 주세요.',
      );
    if (
      receiptErrors.length ||
      job.result_summary.status === 'pending_reconcile' ||
      receipts.some(
        (receipt: AnalysisReceipt): boolean =>
          receipt.saved === null || receipt.state === 'pending_reconcile',
      )
    )
      blockers.push(
        '저장 여부가 미확인인 단계가 있습니다. 영수증 확인 전에는 재개하지 않습니다.',
      );
    if (
      receipts.some(
        (receipt: AnalysisReceipt): boolean =>
          receipt.saved === true &&
          receipt.current_output?.status !== 'current',
      )
    )
      blockers.push(
        '이미 저장한 결과의 현재 판본을 확인할 수 없거나 변경되었습니다. 이전 단계를 다시 저장하지 않습니다.',
      );
    if (
      job.lease_status === 'active' &&
      !['failed', 'stopped'].includes(job.reported_status ?? '')
    )
      blockers.push(
        '유효한 실행 사용권이 있습니다. 현재 실행 종료 또는 만료를 확인해 주세요.',
      );
    if (this.#running)
      blockers.push(
        '이 앱에서 실행 중인 분석을 먼저 중단하거나 완료해 주세요.',
      );
    const profile =
      job.analysis_basis_ref?.profile.profile_id ?? job.actor.profile_id;
    if (profile !== context.selection.profile)
      blockers.push(
        '작업의 고정 관점과 현재 선택 관점이 다릅니다. 같은 관점을 선택해 주세요.',
      );
    if (job.targets.length !== 1)
      blockers.push('현재 개인 실행기는 문서별 단일 대상 작업을 지원합니다.');
    if (
      job.outputs.includes('wiki') &&
      job.source_ref.size_bytes > 4 * 1024 * 1024
    )
      blockers.push('현재 개인 실행기는 UTF-8 원본 4 MiB까지 지원합니다.');
    const preparationBlockers = new Set([
      'fixed_input_bundle_required',
      'input_revalidation_required',
      'personal_ai_execution_required',
    ]);
    for (const blocker of job.blockers)
      if (!preparationBlockers.has(blocker))
        blockers.push(`서버 준비 조건: ${blocker}`);
    if (job.legacy_rebase_required)
      blockers.push(
        '기존 작업의 고정 입력 기준을 명시적으로 다시 준비해야 합니다.',
      );
    return blockers;
  }

  /** 새 작업을 만들지 않고 현재 기준·부분 결과·로컬 환경만 확인합니다. */
  async inspectExecution(
    request: AnalysisReadRequest,
  ): Promise<AnalysisExecutionInspectionResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
      true,
    );
    if ('ok' in context) return context;
    const detail = await this.#detail(context, request.jobId);
    if (!detail.ok) return detail;
    const blockers = this.#executionBlockers(detail.data, context);
    const runtime = await this.#runtime();
    if ('ok' in runtime) blockers.push(runtime.error.message);
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    return {
      ok: true,
      data: {
        detail: detail.data,
        mode: blockers.length
          ? null
          : detail.data.job.state === 'awaiting_cli'
            ? 'start'
            : 'resume',
        blockers,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  /** 사용자가 확인한 작업 판본을 그대로 CLI claim까지 전달하며 중복 job을 만들지 않습니다. */
  async execute(
    request: AnalysisExecuteRequest,
  ): Promise<AnalysisDetailResult> {
    if (this.#starting || this.#running)
      return apiFailure(
        'analysis_busy',
        '이 앱의 기존 분석 실행을 먼저 확인해 주세요.',
      );
    this.#starting = true;
    const epoch = this.#epoch;
    this.#startSettled = new Promise<void>((done: () => void): void => {
      this.#finishStart = done;
    });
    try {
      const context = await this.#connection.analysisContext(
        request.connectionId,
        true,
      );
      if ('ok' in context) return context;
      const detail = await this.#detail(context, request.jobId);
      if (!detail.ok) return detail;
      if (detail.data.job.job_revision !== request.expectedJobRevision)
        return apiFailure(
          'conflict',
          '확인한 뒤 작업 기준이 바뀌었습니다. 최신 상태를 다시 확인한 후 명시적으로 실행해 주세요.',
        );
      const mode =
        detail.data.job.state === 'awaiting_cli' ? 'start' : 'resume';
      if (mode !== request.mode)
        return apiFailure(
          'conflict',
          '작업의 실행 상태가 변경되었습니다. 최신 기준을 다시 확인해 주세요.',
        );
      const blockers = this.#executionBlockers(detail.data, context);
      if (blockers.length)
        return apiFailure('analysis_execution_blocked', blockers.join(' '));
      const runtime = await this.#runtime();
      if ('ok' in runtime) return runtime;
      await this.#spawn(
        context,
        detail.data.job,
        runtime.python,
        runtime.root,
        mode === 'resume',
        epoch,
      );
      return this.#detail(context, request.jobId);
    } catch {
      return apiFailure(
        'analysis_start_failed',
        '기존 작업 실행을 확인하지 못했습니다. 작업과 저장 영수증을 다시 조회해 주세요. 자동 재실행하지 않았습니다.',
      );
    } finally {
      this.#starting = false;
      this.#finishStart?.();
      this.#finishStart = undefined;
    }
  }

  /** 이 앱의 프로세스만 중단하고 서버 작업과 저장 결과는 재개 가능한 상태로 보존합니다. */
  async stopLocal(request: AnalysisReadRequest): Promise<AnalysisDetailResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    if (
      !this.#running ||
      runKey(context, request.jobId) !==
        runKey(this.#running.context, this.#running.jobId)
    )
      return apiFailure(
        'local_execution_missing',
        '이 앱에서 실행 중인 해당 작업이 없습니다. 서버 상태를 확인해 주세요.',
      );
    await this.stop();
    return this.#detail(context, request.jobId);
  }

  /** 종료 전 미확인 접수는 동일 범위의 ID만 복원하고 조회로 확인합니다. */
  async #restoreCreation(context: AnalysisContext): Promise<void> {
    const entries = await readProcessJournal(
      this.#recovery,
      context,
      'pending-analysis',
    );
    const entry = entries.find(
      (value: RecoveryEntry): boolean => value.key === 'creation',
    );
    if (entry) {
      const value = z
        .object({ requestId: identifier })
        .parse(JSON.parse(entry.payload));
      this.#creation = { context, requestId: value.requestId, journal: entry };
    }
  }

  /** 명시된 원본·단일 문서로 한 번 접수한 뒤 기존 개인 AI 어댑터를 실행합니다. */
  async start(request: AnalysisStartRequest): Promise<AnalysisDetailResult> {
    if (this.#starting || this.#running)
      return apiFailure(
        'analysis_busy',
        '이 앱에서 이미 분석을 실행하고 있습니다. 기존 작업을 먼저 확인해 주세요.',
      );
    this.#starting = true;
    const epoch = this.#epoch;
    this.#startSettled = new Promise<void>((done: () => void): void => {
      this.#finishStart = done;
    });
    try {
      const context = await this.#connection.analysisContext(
        request.connectionId,
        true,
      );
      if ('ok' in context) return context;
      await this.#restoreCreation(context);
      let created: z.infer<typeof createdSchema>;
      if (this.#creation) {
        const previous = this.#creation;
        if (
          previous.context.active.serverUrl !== context.active.serverUrl ||
          previous.context.active.userId !== context.active.userId ||
          previous.context.selection.tenant !== context.selection.tenant ||
          previous.context.selection.profile !== context.selection.profile ||
          previous.context.active.policyRevision !==
            context.active.policyRevision
        )
          return apiFailure(
            'creation_unconfirmed',
            '이전 분석 접수 결과를 확인하지 못했습니다. 이전 연결에서 작업 목록을 확인해 주세요.',
          );
        const recovered = await this.#api(
          context,
          `requests/${previous.requestId}`,
        );
        if (!recovered.ok)
          return apiFailure(
            'creation_unconfirmed',
            '분석 접수 결과를 확인하지 못했습니다. 같은 요청을 다시 만들지 말고 작업 목록을 확인해 주세요.',
          );
        created = createdSchema.parse(recovered.value);
        // 이전 클릭의 접수 확인은 조회에서 끝냅니다. 새로운 분석이나 자동 재실행을 만들지 않습니다.
        if (
          created.request_id !== previous.requestId ||
          created.state !== 'complete'
        )
          return apiFailure(
            'creation_unconfirmed',
            '같은 분석 접수의 영수증을 아직 확인하지 못했습니다.',
          );
        await removeProcessJournal(this.#recovery, context, previous.journal);
        this.#creation = null;
        return this.#detail(context, created.job_id);
      }
      const runtime = await this.#runtime();
      if ('ok' in runtime) return runtime;
      const { root, python } = runtime;
      const requestId = randomUUID().replaceAll('-', '');
      const journal = await writeProcessJournal(
        this.#recovery,
        context,
        'pending-analysis',
        'creation',
        {
          requestId,
          sourceId: request.sourceId,
          sourceVersion: request.sourceVersion,
          sourceSha256: request.sourceSha256,
          registrationRevision: request.registrationRevision,
        },
      );
      this.#creation = { context, requestId, journal };
      const response = await this.#api(context, 'analysis-jobs', {
        request_id: requestId,
        source_id: request.sourceId,
        source_version: request.sourceVersion,
        source_sha256: request.sourceSha256,
        expected_registration_revision: request.registrationRevision,
        targets: [request.targetDocument],
        outputs: request.outputs,
      });
      if (!response.ok) {
        // 명확한 거부만 새 접수를 허용합니다. 전송 오류/5xx는 같은 request_id를 보존합니다.
        if (
          response.error.status !== undefined &&
          response.error.status >= 400 &&
          response.error.status < 500
        ) {
          await removeProcessJournal(this.#recovery, context, journal);
          this.#creation = null;
        }
        return response;
      }
      created = createdSchema.parse(response.value);
      if (created.request_id !== requestId) throw new Error('invalid_response');
      if (created.state === 'complete') {
        await removeProcessJournal(this.#recovery, context, journal);
        this.#creation = null;
      }
      const detail = await this.#detail(context, created.job_id);
      if (!detail.ok || created.state !== 'complete') return detail;
      if (detail.data.job.source_ref.size_bytes > 4 * 1024 * 1024)
        return apiFailure(
          'source_too_large',
          '현재 개인 AI 실행은 UTF-8 원본 4 MiB까지 지원합니다. 접수된 작업은 목록에 보존됩니다.',
        );
      await this.#spawn(context, detail.data.job, python, root, false, epoch);
      return this.#detail(context, created.job_id);
    } catch {
      return apiFailure(
        'analysis_start_failed',
        '분석을 시작하지 못했습니다. 작업 목록과 서버 저장 상태를 먼저 확인해 주세요.',
      );
    } finally {
      this.#starting = false;
      this.#finishStart?.();
      this.#finishStart = undefined;
    }
  }

  /** 로컬 경로·토큰은 main이 정합니다. 출력 원문은 화면에 보내지 않고 고정 코드만 읽습니다. */
  async #spawn(
    context: AnalysisContext,
    job: AnalysisJob,
    python: string,
    projectRoot: string,
    reclaim: boolean = false,
    epoch: number = this.#epoch,
  ): Promise<void> {
    const stateKey = runKey(context, job.job_id);
    const privateRoot = join(app.getPath('userData'), 'analysis');
    const runtime = { projectRoot, python };
    const execution = await createPrivateExecution(
      runtime,
      privateRoot,
      context.token,
    );
    let child: ChildProcess;
    try {
      const ai = await personalAi('analysis');
      if (epoch !== this.#epoch || !this.#connection.isAnalysisCurrent(context))
        throw new Error('connection_changed');
      const args = [
        '-B',
        '-m',
        'tools.analysis_cli',
        '--server',
        serverBase(context),
        '--tenant',
        context.selection.tenant,
        '--job-id',
        job.job_id,
        '--expected-job-revision',
        job.job_revision,
        ...(reclaim ? ['--reclaim'] : []),
        '--token-file',
        execution.tokenFile,
        '--work-dir',
        execution.workDirectory,
        '--profile',
        context.selection.profile,
        '--run-ai',
        '--ai-provider',
        ai.provider,
        '--ai-cli',
        ai.cli,
      ];
      child = spawnPersonalProcess(runtime, args);
      child.stdout?.resume();
    } catch {
      await execution.cleanupAuth();
      throw new Error('spawn_failed');
    }
    this.#local.set(stateKey, {
      status: 'running',
      message:
        '개인 AI가 분석 중입니다. 저장 완료 여부는 서버 영수증으로 확인합니다.',
    });
    // 종료 직전 stdin이 닫혀도 EventEmitter 오류가 앱 종료로 번지지 않습니다.
    child.stdin?.on('error', (): void => {});
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer): void => {
      if (stderr.length < 4096)
        stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    const running: Running = {
      child,
      context,
      jobId: job.job_id,
      stopping: false,
      closed: Promise.resolve(),
    };
    running.closed = new Promise<void>((done: () => void): void => {
      child.on('error', (): void => {
        this.#local.set(stateKey, {
          status: 'failed',
          message:
            'Python 분석 실행기를 열 수 없습니다. 실행 환경을 확인해 주세요.',
        });
      });
      child.on('close', (code: number | null): void => {
        const local = this.#local.get(stateKey);
        if (local?.status === 'running') {
          let message =
            code === 0
              ? '로컬 실행이 끝났습니다. 서버 저장 결과를 확인해 주세요.'
              : '로컬 분석이 중단되었습니다. 이미 저장된 결과와 실패 단계를 확인해 주세요.';
          try {
            const failure = z
              .object({
                ok: z.literal(false),
                error: z.object({ code: z.string() }),
              })
              .parse(JSON.parse(stderr));
            if (
              [
                'ai_cli_not_found',
                'ai_cli_unavailable',
                'ai_preflight_failed',
              ].includes(failure.error.code)
            )
              message =
                '선택한 개인 AI CLI를 찾거나 실행할 수 없습니다. 설치 경로와 로그인 상태를 확인해 주세요.';
            else if (
              [
                'analysis_job_changed',
                'job_conflict',
                'analysis_basis_changed',
                'input_basis_changed',
                'plan_context_changed',
                'plan_profile_changed',
                'analysis_saved_output_changed',
              ].includes(failure.error.code)
            )
              message =
                '작업·입력 기준이 변경되어 실행을 멈췄습니다. 저장 결과를 보존했으며 최신 기준을 다시 확인해야 합니다.';
            else if (
              [
                'analysis_result_unconfirmed',
                'analysis_resume_unconfirmed',
              ].includes(failure.error.code)
            )
              message =
                '이전 단계의 저장 영수증을 확정할 수 없어 실행을 멈췄습니다. 결과를 먼저 확인해 주세요.';
            else if (failure.error.code === 'ai_timeout')
              message =
                '개인 AI 응답 시간이 초과되었습니다. 서버에 먼저 저장된 결과를 확인해 주세요.';
            else if (
              ['ai_login_or_execution_failed', 'ai_cli_incompatible'].includes(
                failure.error.code,
              )
            )
              message =
                '선택한 개인 AI의 로그인 또는 실행 준비를 확인해 주세요. 저장된 결과는 서버 조회로 확인할 수 있습니다.';
          } catch {
            /* 원격 오류 문구나 로컬 경로는 공개하지 않습니다. */
          }
          this.#local.set(stateKey, {
            status: code === 0 ? 'completed' : 'failed',
            message,
          });
        }
        // 프로세스가 완전히 닫힌 뒤 이번 실행의 임시 자격 증명만 삭제합니다.
        void execution
          .cleanupAuth()
          .catch((): void => {
            this.#local.set(stateKey, {
              status: this.#local.get(stateKey)?.status ?? 'failed',
              message:
                '실행은 종료되었지만 임시 인증 파일을 정리하지 못했습니다. 앱의 로컬 저장소를 확인해 주세요.',
            });
          })
          .finally((): void => {
            if (this.#running === running) this.#running = null;
            done();
          });
      });
    });
    this.#running = running;
  }

  /** 서버의 현재 CAS로 취소합니다. 서버 취소 실패와 로컬 중단을 구분하며 결과는 보존합니다. */
  async cancel(request: AnalysisCancelRequest): Promise<AnalysisDetailResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
      true,
    );
    if ('ok' in context) return context;
    const result = await this.#api(
      context,
      `analysis-jobs/${request.jobId}/cancel`,
      {
        expected_job_revision: request.expectedJobRevision,
        reason: 'Electron에서 사용자가 분석 중단을 요청함',
      },
    );
    if (!result.ok) return result;
    if (
      this.#running?.jobId === request.jobId &&
      this.#running.context.active.connectionId === context.active.connectionId
    )
      await this.stop();
    return this.#detail(context, request.jobId);
  }
}
