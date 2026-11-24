import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sameAccessRevision } from '@contracts/connection.contract';
import { parseSourceVersionsResponse } from '@contracts/sources.contract';
import { documentTaskSchema } from '@contracts/documentTasks.contract';
import type {
  DocumentTask,
  DocumentTaskCreateRequest,
  DocumentTaskSession,
  DocumentTaskReadRequest,
  DocumentTaskResult,
  DocumentTaskListResult,
  DocumentTaskDetailResult,
  DocumentConversionAttempt,
} from '@contracts/documentTasks.contract';
import type {
  AnalysisStartRequest,
  AnalysisJob,
  AnalysisDetailResult,
  AnalysisReadRequest,
} from '@contracts/analysis.contract';
import type {
  ConversionSource,
  SourceConversionRun,
  SourceConversionReadRequest,
  SourceConversionResult,
} from '@contracts/sourceConversion.contract';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import type { ProcessRecovery } from './processRecovery';
import { readProcessJournal, writeProcessJournal } from './processRecovery';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import { apiFailure, matchesExpectedScope, readApiJson } from './readApi';
import type { ApiFailure } from './readApi';

type Connection = Pick<
  ConnectionService,
  'analysisContext' | 'isAnalysisCurrent' | 'analysisAccessFailure'
>;
type StoredTask = { value: DocumentTask; entry: RecoveryEntry };
type Readers = {
  conversion: (
    request: SourceConversionReadRequest,
  ) => Promise<SourceConversionResult>;
  analysis: (request: AnalysisReadRequest) => Promise<AnalysisDetailResult>;
};
const creationSchema = z.object({
  data: z.object({
    request_id: z.string(),
    state: z.enum(['complete', 'pending_reconcile']),
    job_id: z.string(),
    access: z.object({
      user_id: z.string(),
      tenant: z.string(),
      policy_revision: z.string(),
      access_revision: z.string().optional(),
    }),
  }),
});

/** 판본·hash·등록 기준을 모두 비교하며 최신 판본으로 값을 바꿔 끼우지 않습니다. */
function sameSource(left: ConversionSource, right: ConversionSource): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.sourceVersion === right.sourceVersion &&
    left.sourceSha256 === right.sourceSha256 &&
    left.registrationRevision === right.registrationRevision
  );
}
/** 보고 본문은 서버에 남기고 작업 목록에 필요한 진단·진행·참조만 보존합니다. */
function conversionSnapshot(
  run: SourceConversionRun,
  previous?: DocumentConversionAttempt,
): DocumentConversionAttempt {
  const { report, ...summary } = run;
  const now = new Date().toISOString();
  return {
    ...summary,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    reportSummary: report
      ? {
          complete: report.complete,
          unreadRanges: report.unread_ranges,
          warnings: report.warnings,
        }
      : (previous?.reportSummary ?? null),
  };
}

/** 이 기기의 문서 처리 식별·시도를 보호 저장소에 연결하고 실행은 기존 서비스에 맡깁니다. */
export class DocumentTaskService {
  #connection: Connection;
  #recovery: ProcessRecovery;
  #readers: Readers | null = null;
  #writes: Promise<void> = Promise.resolve();
  #activeConversions = new Set<string>();
  #conversionObserver:
    | ((
        context: AnalysisContext,
        task: DocumentTask,
        run: SourceConversionRun,
      ) => Promise<void>)
    | null = null;

  constructor(connection: Connection, recovery: ProcessRecovery) {
    this.#connection = connection;
    this.#recovery = recovery;
  }

  /** 작업별 변환 guard도 초안과 분리된 같은 보호 저장소를 사용합니다. */
  get recovery(): ProcessRecovery {
    return this.#recovery;
  }

  /** 같은 수명의 변환·분석 서비스만 연결하며 복원 시 프로세스를 시작하지 않습니다. */
  connect(readers: Readers): void {
    this.#readers = readers;
  }

  /** 변환 보고의 서버 알림 연결은 기존 로컬 기록을 저장한 뒤 관측합니다. */
  connectNotifications(
    observer: (
      context: AnalysisContext,
      task: DocumentTask,
      run: SourceConversionRun,
    ) => Promise<void>,
  ): void {
    this.#conversionObserver = observer;
  }

  /** 같은 파일의 관측 갱신은 순서대로 CAS 저장하며 실패를 다음 쓰기로 숨기지 않습니다. */
  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#writes;
    let done: () => void = (): void => {};
    this.#writes = new Promise<void>((resolve: () => void): void => {
      done = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      done();
    }
  }

  /** 응답 직전에도 현재 범위를 확인하여 늦은 응답이 새 공간에 나타나지 않게 합니다. */
  async #context(
    request: DocumentTaskSession,
    write: boolean = false,
  ): Promise<AnalysisContext | ApiFailure> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
      write,
    );
    if ('ok' in context) return context;
    if (!matchesExpectedScope(request.expectedScope, context))
      return apiFailure(
        'scope_changed',
        '작업 공간 또는 조회 기준이 변경되었습니다.',
      );
    return context;
  }

  /** 암호화된 범위의 작업만 읽고 내부 원본 참조의 일치도 확인합니다. */
  async #entries(context: AnalysisContext): Promise<StoredTask[]> {
    const entries = await readProcessJournal(
      this.#recovery,
      context,
      'document-tasks',
    );
    return entries.map((entry: RecoveryEntry): StoredTask => {
      const value = documentTaskSchema.parse(JSON.parse(entry.payload));
      if (
        entry.key !== value.taskId ||
        !sameSource(value.source, value.item) ||
        new Set(
          value.conversions.map(
            (attempt: DocumentConversionAttempt): string => attempt.requestId,
          ),
        ).size !== value.conversions.length ||
        value.conversions.some(
          (attempt: DocumentConversionAttempt): boolean =>
            !sameSource(value.source, attempt.source) ||
            (attempt.reference !== null &&
              (!sameSource(value.source, attempt.reference) ||
                attempt.requestId !== attempt.reference.requestId)),
        )
      )
        throw new Error('task_basis_mismatch');
      return { value, entry };
    });
  }

  /** 식별자가 없는 작업을 새 원본에 대신 연결하지 않습니다. */
  async #find(context: AnalysisContext, taskId: string): Promise<StoredTask> {
    const task = (await this.#entries(context)).find(
      (entry: StoredTask): boolean => entry.value.taskId === taskId,
    );
    if (!task) throw new Error('task_not_found');
    return task;
  }

  /** 작업 상태 쓰기는 현재 범위·원래 판본으로만 수행합니다. */
  async #save(
    context: AnalysisContext,
    task: DocumentTask,
    entry: RecoveryEntry | null,
  ): Promise<void> {
    if (!this.#connection.isAnalysisCurrent(context))
      throw new Error('scope_changed');
    await writeProcessJournal(
      this.#recovery,
      context,
      'document-tasks',
      task.taskId,
      documentTaskSchema.parse(task),
      entry?.revision ?? null,
    );
  }

  /** 원본 카탈로그의 실제 판본·hash·크기를 현재 권한으로 확인합니다. */
  async #source(
    context: AnalysisContext,
    task: Pick<DocumentTask, 'source' | 'item'>,
    requireCurrent: boolean,
  ): Promise<ApiFailure | null> {
    const controller = new AbortController();
    const url = new URL(
      `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/sources/${task.source.sourceId}`,
    );
    url.searchParams.set('profile', context.selection.profile);
    const response = await readApiJson(url.href, context.token, controller);
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure('scope_changed', '조회 중 작업 공간이 변경되었습니다.');
    if (!response.ok) {
      this.#connection.analysisAccessFailure(response);
      return response;
    }
    const source = parseSourceVersionsResponse(
      response.value,
      context.active.connectionId,
    );
    if (
      source.sourceId !== task.source.sourceId ||
      source.access.userId !== context.active.userId ||
      source.access.tenant !== context.selection.tenant ||
      source.access.profileId !== context.selection.profile ||
      !sameAccessRevision(source.access, context.active)
    )
      return apiFailure(
        'scope_changed',
        '원본의 현재 접근 범위를 확인할 수 없습니다.',
      );
    const version = source.versions.find(
      (item: (typeof source.versions)[number]): boolean =>
        item.sourceVersion === task.source.sourceVersion,
    );
    if (
      !version ||
      version.sourceSha256 !== task.source.sourceSha256 ||
      version.sizeBytes !== task.item.sizeBytes ||
      version.format !== task.item.format
    )
      return apiFailure(
        'source_mismatch',
        '작업에 연결된 원본 판본을 확인할 수 없습니다.',
      );
    if (
      requireCurrent &&
      (source.currentVersion !== task.source.sourceVersion ||
        source.registrationRevision !== task.source.registrationRevision)
    )
      return apiFailure(
        'source_changed',
        '원본 등록 기준이 변경되었습니다. 현재 판본을 다시 선택해 주세요.',
      );
    return null;
  }

  /** 원본 접수 뒤 최초 부수 효과 전에 안정된 작업·분석 접수 ID를 보관합니다. */
  async create(
    request: DocumentTaskCreateRequest,
  ): Promise<DocumentTaskResult> {
    const context = await this.#context(request, true);
    if ('ok' in context) return context;
    try {
      const source = {
        sourceId: request.item.sourceId,
        sourceVersion: request.item.sourceVersion,
        sourceSha256: request.item.sourceSha256,
        registrationRevision: request.item.registrationRevision,
      };
      const denied = await this.#source(
        context,
        { source, item: request.item },
        true,
      );
      if (denied) return denied;
      return await this.#serialize(async (): Promise<DocumentTaskResult> => {
        const existing = (await this.#entries(context)).find(
          (task: StoredTask): boolean =>
            sameSource(task.value.source, source) &&
            task.value.targetDocument === request.targetDocument,
        );
        if (existing) return { ok: true, data: existing.value };
        const now = new Date().toISOString();
        const task: DocumentTask = {
          taskId: randomUUID().replaceAll('-', ''),
          source,
          item: request.item,
          targetDocument: request.targetDocument,
          createdAt: now,
          updatedAt: now,
          conversions: [],
          analysisSummary: null,
          registration: {
            requestId: randomUUID().replaceAll('-', ''),
            state: 'not_started',
            jobId: null,
            errorCode: null,
          },
        };
        await this.#save(context, task, null);
        return { ok: true, data: task };
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'recovery_too_large')
        return apiFailure(
          'task_storage_full',
          '이 기기의 작업 기록 저장 공간이 가득 찼습니다. 기존 기록은 보존되며 새 변환·분석은 시작하지 않았습니다.',
        );
      return apiFailure(
        'task_storage_unavailable',
        '작업 기록을 보관하지 못했습니다. 등록된 원본은 보존되며 변환·분석은 시작하지 않았습니다.',
      );
    }
  }

  /** 목록은 이 기기의 전체 기록이며 읽음 여부로 실패 기록을 제거하지 않습니다. */
  async list(request: DocumentTaskSession): Promise<DocumentTaskListResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    try {
      await this.#writes;
      const items = (await this.#entries(context))
        .map((entry: StoredTask): DocumentTask => {
          const task = entry.value;
          const latest = task.conversions.at(-1);
          if (
            latest &&
            ['running', 'cancelling'].includes(latest.state) &&
            !this.#activeConversions.has(latest.requestId)
          ) {
            latest.state = 'report_unconfirmed';
            latest.receiptState = 'unconfirmed';
            latest.message =
              '앱이 다시 시작되어 이전 변환 결과를 확인해야 합니다. 자동으로 다시 실행하지 않았습니다.';
          }
          return task;
        })
        .sort((a: DocumentTask, b: DocumentTask): number =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
      if (!this.#connection.isAnalysisCurrent(context))
        return apiFailure(
          'scope_changed',
          '조회 중 작업 공간이 변경되었습니다.',
        );
      return {
        ok: true,
        data: { items, scope: 'this_device', cleanupWarningCount: 0 },
      };
    } catch {
      return apiFailure(
        'task_recovery_unavailable',
        '작업 기록을 읽지 못했습니다. 기존 보호 자료는 보존됩니다.',
      );
    }
  }

  /** 변환 시작 전 taskId의 범위·원본을 확인하고 서로 다른 작업의 시도를 섞지 않습니다. */
  async assertConversion(
    context: AnalysisContext,
    taskId: string,
    source: ConversionSource,
  ): Promise<void> {
    const { value } = await this.#find(context, taskId);
    if (!sameSource(value.source, source))
      throw new Error('task_basis_mismatch');
    if (value.registration.state === 'unconfirmed' || value.registration.jobId)
      throw new Error('task_analysis_exists');
  }

  /** 프로세스 관측은 requestId별 시도에 추가하며 예전 시도를 덮어쓰지 않습니다. */
  async observeConversion(
    context: AnalysisContext,
    taskId: string,
    run: SourceConversionRun,
  ): Promise<void> {
    const snapshot = structuredClone(run);
    if (['running', 'cancelling'].includes(snapshot.state))
      this.#activeConversions.add(snapshot.requestId);
    else this.#activeConversions.delete(snapshot.requestId);
    await this.#serialize(async (): Promise<void> => {
      const { value, entry } = await this.#find(context, taskId);
      if (!sameSource(value.source, snapshot.source))
        throw new Error('task_basis_mismatch');
      const index = value.conversions.findIndex(
        (attempt: DocumentConversionAttempt): boolean =>
          attempt.requestId === snapshot.requestId,
      );
      const previous = index >= 0 ? value.conversions[index] : undefined;
      const next = conversionSnapshot(snapshot, previous);
      if (
        previous &&
        JSON.stringify({ ...previous, updatedAt: null }) ===
          JSON.stringify({ ...next, updatedAt: null })
      )
        return;
      if (index >= 0) value.conversions[index] = next;
      else value.conversions.push(next);
      value.updatedAt = next.updatedAt;
      await this.#save(context, value, entry);
    });
    if (this.#conversionObserver) {
      const { value } = await this.#find(context, taskId);
      await this.#conversionObserver(context, value, snapshot);
    }
  }

  /** 복원에는 해당 작업의 최신 변환만 쓰고 다른 작업의 최근 원본 변환을 채택하지 않습니다. */
  async conversion(
    context: AnalysisContext,
    taskId: string,
    source: ConversionSource,
  ): Promise<DocumentConversionAttempt | null> {
    await this.#writes;
    const { value } = await this.#find(context, taskId);
    if (!sameSource(value.source, source))
      throw new Error('task_basis_mismatch');
    return value.conversions.at(-1) ?? null;
  }

  /** 서버 POST 전에 접수 미확인 상태를 보관하여 재시작이 새 POST를 만들지 않게 합니다. */
  async prepareAnalysis(
    context: AnalysisContext,
    request: AnalysisStartRequest,
  ): Promise<void> {
    if (!request.taskId) return;
    const taskId = request.taskId;
    await this.#serialize(async (): Promise<void> => {
      const { value, entry } = await this.#find(context, taskId);
      if (
        !sameSource(value.source, request) ||
        value.targetDocument !== request.targetDocument ||
        value.registration.requestId !== request.registration?.requestId ||
        value.registration.jobId ||
        value.registration.state === 'unconfirmed'
      )
        throw new Error('task_registration_mismatch');
      value.registration.state = 'unconfirmed';
      value.registration.errorCode = null;
      value.updatedAt = new Date().toISOString();
      await this.#save(context, value, entry);
    });
  }

  /** 명확한 서버 거부만 실패로 기록하며 네트워크 오류는 접수 미확인으로 보존합니다. */
  async rejectAnalysis(
    context: AnalysisContext,
    taskId: string,
    code: string,
  ): Promise<void> {
    await this.#serialize(async (): Promise<void> => {
      const { value, entry } = await this.#find(context, taskId);
      if (value.registration.jobId) return;
      value.registration.state = 'rejected';
      value.registration.errorCode = code;
      value.updatedAt = new Date().toISOString();
      await this.#save(context, value, entry);
    });
  }

  /** 서버에서 확인한 job만 원본·요청·대상 문서와 대조한 뒤 작업에 연결합니다. */
  async observeAnalysis(
    context: AnalysisContext,
    job: AnalysisJob,
  ): Promise<void> {
    await this.#serialize(async (): Promise<void> => {
      const stored = (await this.#entries(context)).find(
        (entry: StoredTask): boolean =>
          entry.value.registration.requestId === job.request_id,
      );
      if (!stored) return;
      const { value, entry } = stored;
      if (
        !sameSource(value.source, {
          sourceId: job.source_ref.source_id,
          sourceVersion: job.source_ref.source_version,
          sourceSha256: job.source_ref.source_sha256,
          registrationRevision: job.source_ref.registration_revision,
        }) ||
        job.targets.length !== 1 ||
        job.targets[0]?.document !== value.targetDocument ||
        job.user_id !== context.active.userId ||
        job.tenant !== context.selection.tenant ||
        job.actor.profile_id !== context.selection.profile ||
        (value.registration.jobId !== null &&
          value.registration.jobId !== job.job_id)
      )
        throw new Error('task_job_mismatch');
      const summary = {
        state: job.state,
        reportedStatus: job.reported_status,
        resultStatus: job.result_summary.status,
        basisStatus: job.basis_status,
        updatedAt: new Date().toISOString(),
      };
      if (
        value.registration.jobId === job.job_id &&
        value.analysisSummary &&
        JSON.stringify({ ...summary, updatedAt: null }) ===
          JSON.stringify({ ...value.analysisSummary, updatedAt: null })
      )
        return;
      value.registration = {
        ...value.registration,
        state: 'linked',
        jobId: job.job_id,
        errorCode: null,
      };
      value.analysisSummary = summary;
      value.updatedAt = summary.updatedAt;
      await this.#save(context, value, entry);
    });
  }

  /** 미확인 접수는 기존 request 영수증을 GET하며 같은 입력을 POST하지 않습니다. */
  async #reconcile(
    context: AnalysisContext,
    task: DocumentTask,
  ): Promise<string | ApiFailure | null> {
    if (task.registration.jobId) return task.registration.jobId;
    if (task.registration.state !== 'unconfirmed') return null;
    const url = `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/requests/${task.registration.requestId}`;
    const result = await readApiJson(url, context.token, new AbortController());
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure('scope_changed', '조회 중 작업 공간이 변경되었습니다.');
    if (!result.ok) {
      this.#connection.analysisAccessFailure(result);
      return result;
    }
    const { data } = creationSchema.parse(result.value);
    if (
      data.request_id !== task.registration.requestId ||
      data.access.user_id !== context.active.userId ||
      data.access.tenant !== context.selection.tenant ||
      !sameAccessRevision(
        {
          policyRevision: data.access.policy_revision,
          accessRevision: data.access.access_revision,
        },
        context.active,
      )
    )
      throw new Error('task_receipt_mismatch');
    return data.state === 'complete'
      ? data.job_id
      : apiFailure(
          'creation_unconfirmed',
          '분석 접수 결과를 아직 확인하지 못했습니다.',
        );
  }

  /** 상세 복원은 기존 영수증과 알림만 연결하며 변환·분석 프로세스를 시작하지 않습니다. */
  async read(
    request: DocumentTaskReadRequest,
  ): Promise<DocumentTaskDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    try {
      await this.#writes;
      let task = (await this.#find(context, request.taskId)).value;
      const errors: Extract<
        DocumentTaskDetailResult,
        { ok: true }
      >['data']['errors'] = [];
      const sourceError = await this.#source(context, task, false);
      if (sourceError) errors.push({ stage: 'source', ...sourceError.error });
      if (
        sourceError &&
        [
          'scope_changed',
          'unauthorized',
          'forbidden',
          'subject_changed',
        ].includes(sourceError.error.code)
      )
        return sourceError;
      let conversion: SourceConversionRun | null = null;
      let analysis: Extract<AnalysisDetailResult, { ok: true }>['data'] | null =
        null;
      if (!this.#readers) throw new Error('task_readers_missing');
      if (
        task.conversions.length ||
        (!['md', 'txt'].includes(task.item.format) && !task.registration.jobId)
      ) {
        const converted = await this.#readers.conversion({
          connectionId: request.connectionId,
          expectedScope: request.expectedScope,
          ...task.source,
          taskId: task.taskId,
        });
        if (converted.ok) {
          conversion = converted.data;
          if (conversion && this.#conversionObserver) {
            try {
              await this.#conversionObserver(context, task, conversion);
            } catch {
              errors.push({
                stage: 'conversion',
                code: 'notification_sync_failed',
                message:
                  '변환 보고는 보존되어 있지만 서버 알림 연결을 확인하지 못했습니다. 연결 상태를 확인하고 새로고침해 주세요.',
              });
            }
          }
          if (conversion?.historyWarning)
            errors.push({
              stage: 'conversion',
              code: 'task_history_write_failed',
              message: conversion.historyWarning,
            });
        } else errors.push({ stage: 'conversion', ...converted.error });
      }
      const jobId = await this.#reconcile(context, task);
      if (typeof jobId === 'string') {
        const result = await this.#readers.analysis({
          connectionId: request.connectionId,
          jobId,
        });
        if (result.ok) {
          await this.observeAnalysis(context, result.data.job);
          analysis = result.data;
        } else errors.push({ stage: 'analysis', ...result.error });
      } else if (jobId) errors.push({ stage: 'analysis', ...jobId.error });
      task = (await this.#find(context, request.taskId)).value;
      if (!this.#connection.isAnalysisCurrent(context))
        return apiFailure(
          'scope_changed',
          '조회 중 작업 공간이 변경되었습니다.',
        );
      return { ok: true, data: { task, conversion, analysis, errors } };
    } catch {
      return apiFailure(
        'task_recovery_unavailable',
        '작업 상세를 복원하지 못했습니다. 기존 기록을 보존하며 자동 실행하지 않았습니다.',
      );
    }
  }
}
