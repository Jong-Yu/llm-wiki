import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NotificationContentReader } from './NotificationContentReader';
import {
  notificationDetailDataSchema,
  notificationListDataSchema,
  notificationMutationDataSchema,
  notificationReadStateDataSchema,
  notificationAccessSchema,
  notificationApproveSchema,
  notificationLocation,
  notificationLocationKey,
  notificationRecoverImagesDataSchema,
} from '@contracts/notifications.contract';
import type {
  NotificationSession,
  NotificationListRequest,
  NotificationReadRequest,
  NotificationMarkReadRequest,
  NotificationDismissRequest,
  NotificationDecideRequest,
  NotificationApproveRequest,
  NotificationContinueRequest,
  NotificationPageRequest,
  NotificationListResult,
  NotificationDetailResult,
  NotificationReadStateResult,
  NotificationMutationResult,
  NotificationInspectionResult,
  NotificationContinueResult,
  NotificationPageResult,
  NotificationWorkflow,
  NotificationCorrectRequest,
  NotificationRetryPageRequest,
  NotificationRetryPageResult,
  NotificationCancelRetryRequest,
  NotificationCancelRetryResult,
  NotificationRecoverImagesRequest,
  NotificationRecoverImagesResult,
} from '@contracts/notifications.contract';
import { conversionNeedsContentReview } from '@contracts/sourceConversion.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import type { DocumentTask } from '@contracts/documentTasks.contract';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import type { AnalysisService } from './AnalysisService';
import type { AnalysisJob } from '@contracts/analysis.contract';
import type { NotificationDevice } from './notificationDevice';
import {
  apiFailure,
  matchesExpectedScope,
  readScopedApiJson,
  readApiPageBytes,
} from './readApi';
import type { ApiFailure, ReadApiResult } from './readApi';
import type { ProcessRecovery } from './processRecovery';
import {
  readProcessJournal,
  writeProcessJournal,
  removeProcessJournal,
} from './processRecovery';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import { ExecutionStarts } from './ExecutionStarts';
import type { SourcePageOcrService } from './SourcePageOcrService';
import type {
  SourceImageRecoveryService,
  ImageRecoveryInput,
  ImageRecoveryUnit,
} from './SourceImageRecoveryService';

type Connection = Pick<
  ConnectionService,
  | 'analysisContext'
  | 'isAnalysisCurrent'
  | 'analysisAccessFailure'
  | 'onScopeChanged'
>;
type Analysis = Pick<
  AnalysisService,
  'inspectRuntime' | 'start' | 'inspectExecution' | 'execute'
>;
const envelope = z.object({
  data: z.looseObject({ access: notificationAccessSchema }),
});
const pendingApproval = z.object({
  workflowId: z.string(),
  requestId: z.string(),
  expectedRevision: z.string(),
  targetDocument: z.string().optional(),
  correctionRefs: notificationApproveSchema.shape.correctionRefs,
  correctionsRevision: notificationApproveSchema.shape.correctionsRevision,
});
const executionEntry = z.object({
  workflowId: z.string(),
  stage: z.enum(['claim', 'registration', 'started']),
  requestId: z.string(),
  expectedRevision: z.string(),
  reclaim: z.boolean().default(false),
  priorClaimId: z.string().nullable().default(null),
});
const outboxEntry = z.object({
  path: z.enum(['notification-workflows', 'notification-events']),
  body: z.record(z.string(), z.unknown()),
});

/** 사용자 요청마다 새 ID를 만들지 않고 해당 단계의 안정된 멱등 키를 계산합니다. */
function stepId(value: string, step: string): string {
  return createHash('sha256')
    .update(`${value}:${step}`)
    .digest('hex')
    .slice(0, 32);
}
/** 늦은 응답과 다른 계정의 승인을 현재 화면에 적용하지 않습니다. */
function changed(): ApiFailure {
  return apiFailure(
    'scope_changed',
    '작업 공간 또는 조회 설정이 변경되었습니다. 현재 범위에서 다시 확인해 주세요.',
  );
}

/** 재인식 취소는 같은 계정·관점·요청의 개인 실행에만 적용합니다. */
function pageRetryKey(request: NotificationCancelRetryRequest): string {
  const scope = request.expectedScope;
  return JSON.stringify([
    request.connectionId,
    scope.userId,
    scope.tenant,
    scope.profileId,
    scope.policyRevision,
    scope.accessRevision ?? null,
    request.workflowId,
    request.requestId,
  ]);
}

/** 저신뢰 진단을 유일한 단일 슬라이드로 연결하고 기존 보정·입력 대상을 보존합니다. */
function imageRecoveryInput(
  data: Extract<NotificationDetailResult, { ok: true }>['data'],
  revision: string,
): ImageRecoveryInput | null {
  const { workflow, conversion } = data;
  if (
    data.source_format !== 'pptx' ||
    workflow.state !== 'review' ||
    workflow.blocked_reason ||
    workflow.revision !== revision ||
    !workflow.conversion_ref ||
    !conversion ||
    !workflow.pages.length ||
    workflow.pages.some(
      (page: NotificationWorkflow['pages'][number]): boolean =>
        !!page.whole_document || !!page.input_required || !!page.correction_ref,
    ) ||
    data.corrections.length
  )
    return null;
  const slides = new Set<number>();
  for (const range of conversion.manifest.unread_ranges) {
    const match =
      /^slide ([1-9][0-9]*): ocr_low_or_missing_confidence_text_retained_manual_review_required$/.exec(
        range,
      );
    if (!match) return null;
    slides.add(Number(match[1]));
  }
  if (!slides.size || slides.size > 40) return null;
  const units: ImageRecoveryUnit[] = [];
  for (const slide of slides) {
    // 범위 단위가 겹치는 경우에도 첫 후보를 임의 선택하지 않습니다.
    const matches = conversion.manifest.units.filter(
      (unit: (typeof conversion.manifest.units)[number]): boolean =>
        unit.location.kind === 'slides' &&
        typeof unit.location.start === 'number' &&
        typeof unit.location.end === 'number' &&
        unit.location.start <= slide &&
        unit.location.end >= slide,
    );
    const unit = matches[0];
    if (
      matches.length !== 1 ||
      !unit ||
      unit.location.kind !== 'slides' ||
      unit.location.start !== slide ||
      unit.location.end !== slide ||
      workflow.pages.filter(
        (page: NotificationWorkflow['pages'][number]): boolean =>
          page.unit_id === unit.unit_id,
      ).length !== 1
    )
      return null;
    const content = conversion.components[unit.unit_id];
    if (typeof content !== 'string' || !content.trim()) return null;
    units.push({
      unit_id: unit.unit_id,
      content,
      location: { kind: 'slides', start: slide, end: slide },
    });
  }
  if (
    new Set(units.map((unit: ImageRecoveryUnit): string => unit.unit_id))
      .size !== units.length ||
    workflow.pages.length !== units.length
  )
    return null;
  return {
    source_ref: workflow.source_ref,
    conversion_ref: workflow.conversion_ref,
    units,
  };
}

/** 서버의 알림·페이지 확인·승인 영수증을 소유하고 실행은 기존 개인 실행기에 연결합니다. */
export class NotificationService {
  readonly #connection: Connection;
  readonly #analysis: Analysis;
  readonly #device: NotificationDevice;
  readonly #recovery: ProcessRecovery;
  readonly #requests = new Set<AbortController>();
  readonly #contentReader: NotificationContentReader;
  readonly #starts = new ExecutionStarts();
  readonly #flushes = new ExecutionStarts();
  readonly #pageOcr: Pick<SourcePageOcrService, 'run' | 'stop'> | undefined;
  readonly #imageRecovery:
    | Pick<SourceImageRecoveryService, 'run' | 'stop'>
    | undefined;
  readonly #pageRetries = new Map<string, AbortController>();

  constructor(
    connection: Connection,
    analysis: Analysis,
    device: NotificationDevice,
    recovery: ProcessRecovery,
    pageOcr?: Pick<SourcePageOcrService, 'run' | 'stop'>,
    imageRecovery?: Pick<SourceImageRecoveryService, 'run' | 'stop'>,
  ) {
    this.#connection = connection;
    this.#analysis = analysis;
    this.#device = device;
    this.#recovery = recovery;
    this.#pageOcr = pageOcr;
    this.#imageRecovery = imageRecovery;
    this.#contentReader = new NotificationContentReader(
      (context: AnalysisContext, path: string): Promise<ReadApiResult> =>
        this.#api(context, path),
    );
    connection.onScopeChanged((): void => {
      for (const controller of this.#requests) controller.abort();
    });
  }

  /** 종료 시 후보 생성만 중단하며 원본·보관 보고·서버 보정은 변경하지 않습니다. */
  async stop(): Promise<void> {
    for (const controller of this.#pageRetries.values()) controller.abort();
    await this.#pageOcr?.stop();
    await this.#imageRecovery?.stop();
  }

  /** 다른 PC의 claim을 화면에서 복사해도 이 PC의 직접 분석 실행으로 우회할 수 없습니다. */
  async validateExecution(
    context: AnalysisContext,
    job: AnalysisJob,
    claimId: string | undefined,
  ): Promise<ApiFailure | null> {
    const reference = job.registration?.conversion_ref;
    if (!reference)
      return claimId
        ? apiFailure(
            'execution_claim_invalid',
            '이 작업의 실행 승인 식별자가 아닙니다.',
          )
        : null;
    const result = await this.#api(
      context,
      `notification-workflows/${reference.conversion_id}`,
    );
    if (!result.ok)
      return result.error.code === 'not_found' && !claimId ? null : result;
    const detail = notificationDetailDataSchema.parse(result.value);
    const workflow = detail.workflow;
    if (workflow.blocked_reason)
      return apiFailure(
        workflow.blocked_reason,
        '원본 또는 변환 보고가 바뀌었습니다. 최신 보고에서 다시 확인해 주세요.',
      );
    if (!workflow.pages.length && !claimId) return null;
    if (
      !workflow.approval ||
      workflow.execution?.claim_id !== claimId ||
      workflow.execution?.device_id !== this.#device.deviceId ||
      workflow.execution?.job_id !== job.job_id ||
      workflow.conversion_ref?.conversion_revision !==
        reference.conversion_revision
    )
      return apiFailure(
        'execution_claim_invalid',
        '승인한 작업과 현재 PC의 실행 소유권을 다시 확인해 주세요.',
      );
    return null;
  }

  /** 화면에 고정된 주체·작업 공간을 쓰기 직전에도 검증합니다. */
  async #context(
    request: NotificationSession,
    write: boolean = false,
  ): Promise<AnalysisContext | ApiFailure> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
      write,
    );
    if ('ok' in context) return context;
    return matchesExpectedScope(request.expectedScope, context)
      ? context
      : changed();
  }

  /** 응답 전체는 업무 스키마에서 다시 검사하고 원격 오류 원문을 반사하지 않습니다. */
  async #api(
    context: AnalysisContext,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: true; value: unknown } | ApiFailure> {
    const result = await readScopedApiJson(
      this.#connection,
      this.#requests,
      context,
      path,
      {
        schema: envelope,
        changed,
        invalidMessage: '알림 응답을 확인할 수 없습니다.',
        profile: 'get-query',
        body,
        maxResponseBytes: 8 * 1024 * 1024,
      },
    );
    if (!result.ok) {
      const messages: Record<string, string> = {
        correction_basis_changed:
          '수정된 문자를 다시 확인한 뒤 승인해 주세요. 구버전 앱이라면 새 버전으로 열어 주세요.',
        approval_basis_changed:
          '승인한 수정본과 현재 처리 기준이 다릅니다. 최신 검토 기록을 다시 확인해 주세요.',
        page_approval_required:
          '확인 전이거나 보류한 쪽이 남아 있습니다. 해당 쪽을 다시 인식하거나 직접 수정한 뒤 문자 사용을 확인해 주세요.',
      };
      const message = messages[result.error.code];
      if (message) return { ...result, error: { ...result.error, message } };
    }
    return result;
  }

  /** 재연결은 저장된 로컬 보고를 같은 멱등 키로 전송하며 실행·승인은 재시도하지 않습니다. */
  async flush(context: AnalysisContext): Promise<void> {
    const finish = this.#flushes.begin(context.active.connectionId);
    if (!finish) return;
    try {
      for (const entry of await readProcessJournal(
        this.#recovery,
        context,
        'notification-outbox',
      )) {
        if (!this.#connection.isAnalysisCurrent(context)) return;
        const pending = outboxEntry.safeParse(JSON.parse(entry.payload));
        if (!pending.success) continue;
        const result = await this.#api(
          context,
          pending.data.path,
          pending.data.body,
        );
        if (result.ok)
          await removeProcessJournal(this.#recovery, context, entry);
        else if (
          !result.error.status ||
          result.error.status >= 500 ||
          [401, 403].includes(result.error.status)
        )
          return;
        // 한 사건의 판본/입력 거부는 보존하되 뒤에 쌓인 다른 사건의 전달을 막지 않는다.
      }
    } finally {
      finish();
    }
  }

  /** 원본 보고와 로컬 시도를 보존한 뒤 서버 알림 연결을 별도 outbox에 보관합니다. */
  async observeConversion(
    context: AnalysisContext,
    task: DocumentTask,
    run: SourceConversionRun,
  ): Promise<void> {
    const review =
      run.receiptState === 'saved' &&
      run.reference &&
      conversionNeedsContentReview(run.report);
    const failure = ['failed', 'cancelled', 'report_unconfirmed'].includes(
      run.state,
    );
    if (!review && !failure) return;
    const source = {
      source_id: task.source.sourceId,
      source_version: task.source.sourceVersion,
      source_sha256: task.source.sourceSha256,
      registration_revision: task.source.registrationRevision,
    };
    const reference = run.reference
      ? {
          conversion_id: run.reference.conversionId,
          conversion_revision: run.reference.conversionRevision,
        }
      : null;
    const requestId = stepId(run.requestId, review ? 'review' : run.state);
    const body = review
      ? {
          request_id: requestId,
          source_ref: source,
          conversion_ref: reference,
          title: task.item.title,
          target_document: task.targetDocument,
        }
      : {
          request_id: requestId,
          source_ref: source,
          conversion_ref: reference,
          job_id: null,
          kind: run.state === 'cancelled' ? 'stopped' : 'failed',
          title: task.item.title,
          device_id: this.#device.deviceId,
          device_name: this.#device.deviceName,
          ...(run.diagnosticCodes.length
            ? { diagnostic_codes: run.diagnosticCodes }
            : {}),
        };
    const existing = (
      await readProcessJournal(this.#recovery, context, 'notification-outbox')
    ).find((entry: RecoveryEntry): boolean => entry.key === requestId);
    if (!existing)
      await writeProcessJournal(
        this.#recovery,
        context,
        'notification-outbox',
        requestId,
        {
          path: review ? 'notification-workflows' : 'notification-events',
          body,
        },
      );
    await this.flush(context);
  }

  /** 서버가 보존한 전체 기록을 페이지 단위로 읽습니다. */
  async list(
    request: NotificationListRequest,
  ): Promise<NotificationListResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    await this.flush(context);
    const query = new URLSearchParams({
      filter: request.filter ?? 'all',
      limit: String(request.limit ?? 50),
    });
    if (request.cursor) query.set('cursor', request.cursor);
    if (request.afterSequence !== undefined)
      query.set('after_seq', String(request.afterSequence));
    const result = await this.#api(
      context,
      `notifications?${query.toString()}`,
    );
    return result.ok
      ? { ok: true, data: notificationListDataSchema.parse(result.value) }
      : result;
  }

  /** 보고의 불변 참조를 대조하고 승인 접수 미확인은 같은 영수증 조회로만 해소합니다. */
  async read(
    request: NotificationReadRequest,
  ): Promise<NotificationDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    await this.flush(context);
    const result = await this.#contentReader.read(context, request.workflowId);
    if (!result.ok) return result;
    const { data } = result;
    const { workflow } = data;
    if (workflow.approval) {
      const pending = (
        await readProcessJournal(
          this.#recovery,
          context,
          'notification-approvals',
        )
      ).find(
        (entry: RecoveryEntry): boolean => entry.key === workflow.workflow_id,
      );
      if (pending) {
        const approval = pendingApproval.parse(JSON.parse(pending.payload));
        if (approval.requestId === workflow.approval.request_id)
          await removeProcessJournal(this.#recovery, context, pending);
      }
    }
    return { ok: true, data };
  }

  /** 읽음은 페이지 확인이나 실행 승인과 분리해 저장합니다. */
  async markRead(
    request: NotificationMarkReadRequest,
  ): Promise<NotificationReadStateResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#api(context, 'notifications/read', {
      notification_ids: request.notificationIds,
      read: request.read,
    });
    return result.ok
      ? { ok: true, data: notificationReadStateDataSchema.parse(result.value) }
      : result;
  }

  /** 개인 알림 목록에서만 제거하고 원본 문서와 처리 이력을 보존합니다. */
  async dismiss(
    request: NotificationDismissRequest,
  ): Promise<NotificationReadStateResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#api(context, 'notifications/dismiss', {
      notification_ids: request.notificationIds,
    });
    return result.ok
      ? { ok: true, data: notificationReadStateDataSchema.parse(result.value) }
      : result;
  }

  /** 페이지 확인은 사용자가 관측한 workflow 판본으로 CAS 저장합니다. */
  async decide(
    request: NotificationDecideRequest,
  ): Promise<NotificationMutationResult> {
    const context = await this.#context(request, true);
    if ('ok' in context) return context;
    const result = await this.#api(
      context,
      `notification-workflows/${request.workflowId}/pages`,
      {
        request_id: request.requestId,
        expected_revision: request.expectedRevision,
        decisions: request.decisions,
      },
    );
    return result.ok
      ? { ok: true, data: notificationMutationDataSchema.parse(result.value) }
      : result;
  }

  /** 원래 보고는 보존하고 사용자가 본 판본에 수정 문자를 별도로 저장합니다. */
  async correct(
    request: NotificationCorrectRequest,
  ): Promise<NotificationMutationResult> {
    const finish = this.#starts.begin(
      `correct:${request.connectionId}:${request.workflowId}`,
    );
    if (!finish)
      return apiFailure(
        'correction_busy',
        '수정 문자의 저장 결과를 확인하고 있습니다.',
      );
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      // 먼저 최신 판본으로 바꾸지 않습니다. 응답 유실 재시도도 원래 요청으로 검증합니다.
      const result = await this.#api(
        context,
        `notification-workflows/${request.workflowId}/corrections`,
        {
          request_id: request.requestId,
          expected_revision: request.expectedRevision,
          ...notificationLocation(request),
          method: request.method,
          content: request.content,
          warnings: request.warnings ?? [],
        },
      );
      if (!result.ok) return result;
      const data = notificationMutationDataSchema.parse(result.value);
      if (
        data.workflow.workflow_id !== request.workflowId ||
        !data.workflow.pages.some(
          (page: NotificationWorkflow['pages'][number]): boolean =>
            notificationLocationKey(page) ===
              notificationLocationKey(request) && !!page.correction_ref,
        )
      )
        return apiFailure(
          'correction_unconfirmed',
          '수정 문자의 저장 여부를 다시 확인해 주세요. 원래 요청은 새로 만들지 않습니다.',
        );
      return { ok: true, data };
    } finally {
      finish();
    }
  }

  /** 선택한 원본 한 쪽을 개인 PC에서 다시 읽고 저장 전 검토 후보만 반환합니다. */
  async retryPage(
    request: NotificationRetryPageRequest,
  ): Promise<NotificationRetryPageResult> {
    if (!this.#pageOcr)
      return apiFailure(
        'page_ocr_unavailable',
        '이 PC의 문자 인식 실행기를 준비해 주세요. 문자를 직접 수정할 수도 있습니다.',
      );
    const finish = this.#starts.begin('page-ocr');
    if (!finish)
      return apiFailure(
        'conversion_busy',
        '이 PC에서 다른 쪽의 문자를 다시 인식하고 있습니다.',
      );
    const controller = new AbortController();
    const key = pageRetryKey(request);
    this.#pageRetries.set(key, controller);
    this.#requests.add(controller);
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      const detail = await this.read(request);
      if (!detail.ok) return detail;
      const workflow = detail.data.workflow;
      if (
        workflow.state !== 'review' ||
        workflow.blocked_reason ||
        workflow.revision !== request.expectedRevision ||
        !workflow.pages.some(
          (page: NotificationWorkflow['pages'][number]): boolean =>
            page.page === request.page,
        )
      )
        return apiFailure(
          'conflict',
          '검토 상태가 변경되었습니다. 최신 상태에서 다시 문자 인식을 시작해 주세요.',
        );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (controller.signal.aborted)
        return apiFailure(
          'cancelled',
          '문자 재인식을 취소했습니다. 보관 문자는 그대로입니다.',
        );
      const result = await this.#pageOcr.run(
        context,
        workflow.source_ref,
        request.page,
        request.requestId,
        controller.signal,
      );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (controller.signal.aborted)
        return apiFailure(
          'cancelled',
          '문자 재인식을 취소했습니다. 보관 문자는 그대로입니다.',
        );
      if (!result.ok) return result;
      const current = await this.read(request);
      if (!current.ok) return current;
      if (current.data.workflow.revision !== request.expectedRevision)
        return apiFailure(
          'conflict',
          '재인식 중 검토 상태가 변경되었습니다. 새 상태를 확인한 뒤 다시 시도해 주세요.',
        );
      if (result.data.page !== request.page)
        return apiFailure(
          'invalid_page',
          '선택한 쪽의 재인식 결과를 확인할 수 없습니다.',
        );
      return result;
    } finally {
      this.#pageRetries.delete(key);
      this.#requests.delete(controller);
      finish();
    }
  }

  /** 명시한 요청에서만 그림 복구 후보를 만들며 서버 보고·보정·승인을 쓰지 않습니다. */
  async recoverImages(
    request: NotificationRecoverImagesRequest,
  ): Promise<NotificationRecoverImagesResult> {
    if (!this.#imageRecovery)
      return apiFailure(
        'image_recovery_unavailable',
        '이 PC의 개인 AI 실행기를 준비해 주세요. 내용을 직접 수정할 수도 있습니다.',
      );
    const finish = this.#starts.begin('page-ocr');
    if (!finish)
      return apiFailure(
        'conversion_busy',
        '이 PC에서 다른 문자를 다시 읽고 있습니다.',
      );
    const controller = new AbortController();
    const key = pageRetryKey(request);
    this.#pageRetries.set(key, controller);
    this.#requests.add(controller);
    const cancelled = (): ApiFailure =>
      apiFailure(
        'cancelled',
        '그림 문자 복구를 취소했습니다. 원래 내용은 보존됩니다.',
      );
    const conflict = (): ApiFailure =>
      apiFailure(
        'conflict',
        '검토 내용이나 원본이 변경되었거나 복구 대상을 확정할 수 없습니다. 현재 내용을 다시 확인해 주세요.',
      );
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      // 일반 조회의 outbox flush를 실행하지 않아 후보 생성에 서버 쓰기가 섞이지 않습니다.
      const detail = await this.#contentReader.read(
        context,
        request.workflowId,
      );
      if (!detail.ok) return detail;
      const input = imageRecoveryInput(detail.data, request.expectedRevision);
      if (!input) return conflict();
      const before = await this.#context(request, true);
      if ('ok' in before) return before;
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (controller.signal.aborted) return cancelled();
      const result = await this.#imageRecovery.run(
        context,
        input,
        request.requestId,
        controller.signal,
      );
      // 실행기가 정리 실패를 함께 알린 취소 오류는 일반 취소 문구로 덮지 않습니다.
      if (!result.ok) return result;
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (controller.signal.aborted) return cancelled();
      const after = await this.#context(request, true);
      if ('ok' in after) return after;
      const current = await this.#contentReader.read(after, request.workflowId);
      if (!current.ok) return current;
      const currentInput = imageRecoveryInput(
        current.data,
        request.expectedRevision,
      );
      if (
        !currentInput ||
        JSON.stringify(currentInput) !== JSON.stringify(input)
      )
        return conflict();
      const permission = await this.#context(request, true);
      if ('ok' in permission) return permission;
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (controller.signal.aborted) return cancelled();
      const parsed = notificationRecoverImagesDataSchema.safeParse(result.data);
      if (
        !parsed.success ||
        parsed.data.units.length !== input.units.length ||
        parsed.data.units.some(
          (unit: { unit_id: string }): boolean =>
            !input.units.some(
              (target: ImageRecoveryUnit): boolean =>
                target.unit_id === unit.unit_id,
            ),
        )
      )
        return apiFailure(
          'invalid_image_recovery',
          '선택한 슬라이드의 복구 결과를 확인할 수 없습니다. 원래 내용은 보존됩니다.',
        );
      return { ok: true, data: parsed.data };
    } finally {
      this.#pageRetries.delete(key);
      this.#requests.delete(controller);
      finish();
    }
  }

  /** 취소 요청으로 보관된 페이지 판단이나 수정 결과를 지우지 않습니다. */
  async cancelRetry(
    request: NotificationCancelRetryRequest,
  ): Promise<NotificationCancelRetryResult> {
    const context = await this.#context(request, true);
    if ('ok' in context) return context;
    const controller = this.#pageRetries.get(pageRetryKey(request));
    controller?.abort();
    return { ok: true, data: { cancelled: !!controller } };
  }

  /** 승인 전 요청을 보호 저장하고 명시 재시도도 같은 요청만 사용합니다. */
  async approve(
    request: NotificationApproveRequest,
  ): Promise<NotificationMutationResult> {
    const finish = this.#starts.begin(
      `approve:${request.connectionId}:${request.workflowId}`,
    );
    if (!finish)
      return apiFailure(
        'approval_busy',
        '같은 승인의 저장 결과를 확인하고 있습니다.',
      );
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      let entry =
        (
          await readProcessJournal(
            this.#recovery,
            context,
            'notification-approvals',
          )
        ).find(
          (item: RecoveryEntry): boolean => item.key === request.workflowId,
        ) ?? null;
      let intent: z.infer<typeof pendingApproval> = {
        workflowId: request.workflowId,
        requestId: request.requestId,
        expectedRevision: request.expectedRevision,
        correctionRefs: request.correctionRefs,
        correctionsRevision: request.correctionsRevision,
        ...(request.targetDocument
          ? { targetDocument: request.targetDocument }
          : {}),
      };
      if (entry) {
        intent = pendingApproval.parse(JSON.parse(entry.payload));
        const observed = await this.read(request);
        if (!observed.ok) return observed;
        if (observed.data.workflow.approval)
          return {
            ok: true,
            data: {
              workflow: observed.data.workflow,
              replayed: true,
              access: observed.data.access,
            },
          };
        // 재조회에서 영수증이 아직 없을 때의 명시 재시도만 최초 요청을 그대로 재사용합니다.
      } else {
        entry = await writeProcessJournal(
          this.#recovery,
          context,
          'notification-approvals',
          request.workflowId,
          intent,
        );
      }
      const result = await this.#api(
        context,
        `notification-workflows/${request.workflowId}/approve`,
        {
          request_id: intent.requestId,
          expected_revision: intent.expectedRevision,
          device_id: this.#device.deviceId,
          device_name: this.#device.deviceName,
          ...(intent.correctionsRevision
            ? { corrections_revision: intent.correctionsRevision }
            : {}),
          ...(intent.correctionRefs
            ? { correction_refs: intent.correctionRefs }
            : {}),
          ...(intent.targetDocument
            ? { target_document: intent.targetDocument }
            : {}),
        },
      );
      if (!result.ok) {
        if (
          result.error.status &&
          result.error.status >= 400 &&
          result.error.status < 500
        )
          await removeProcessJournal(this.#recovery, context, entry);
        return result;
      }
      const data = notificationMutationDataSchema.parse(result.value);
      if (
        data.workflow.workflow_id !== request.workflowId ||
        data.workflow.approval?.request_id !== intent.requestId
      )
        return apiFailure(
          'approval_unconfirmed',
          '승인 영수증이 요청과 일치하는지 다시 조회해 주세요.',
        );
      await removeProcessJournal(this.#recovery, context, entry);
      return { ok: true, data };
    } finally {
      finish();
    }
  }

  /** 이 PC의 준비 상태와 다른 기기의 실행 소유권을 함께 안내합니다. */
  async inspect(
    request: NotificationReadRequest,
  ): Promise<NotificationInspectionResult> {
    const detail = await this.read(request);
    if (!detail.ok) return detail;
    const blockers = await this.#analysis.inspectRuntime();
    const workflow = detail.data.workflow;
    if (workflow.blocked_reason)
      blockers.push(
        '원본 또는 변환 보고가 바뀌었습니다. 최신 보고에서 다시 확인해 주세요.',
      );
    if (
      !['failed', 'stopped'].includes(workflow.state) &&
      workflow.execution?.device_id &&
      workflow.execution.device_id !== this.#device.deviceId
    )
      blockers.push(
        `${workflow.execution.device_name}에서 이어서 처리 중입니다.`,
      );
    if (['running', 'complete'].includes(workflow.state))
      blockers.push(
        workflow.state === 'complete'
          ? '이미 결과가 저장되었습니다.'
          : '기존 실행의 결과를 확인해 주세요.',
      );
    const current = await this.#context(request);
    if ('ok' in current) return current;
    return {
      ok: true,
      data: {
        ready: blockers.length === 0,
        blockers,
        ...this.#device,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  /** 전역 claim → 안정된 분석 접수 → 서버 연결 후에만 한 번 로컬 프로세스를 시작합니다. */
  async continue(
    request: NotificationContinueRequest,
  ): Promise<NotificationContinueResult> {
    const finish = this.#starts.begin(
      `continue:${request.connectionId}:${request.workflowId}`,
    );
    if (!finish)
      return apiFailure(
        'execution_busy',
        '같은 작업의 이어서 처리를 확인하고 있습니다.',
      );
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      const detail = await this.read(request);
      if (!detail.ok) return detail;
      let workflow = detail.data.workflow;
      if (workflow.blocked_reason)
        return apiFailure(
          workflow.blocked_reason,
          '원본 또는 변환 보고가 바뀌었습니다. 최신 보고에서 다시 확인해 주세요.',
        );
      if (
        !workflow.approval ||
        !workflow.target_document ||
        !workflow.conversion_ref
      )
        return apiFailure(
          'approval_required',
          '확인할 쪽과 저장할 문서를 승인한 뒤 이어서 처리해 주세요.',
        );
      if (
        !['failed', 'stopped'].includes(workflow.state) &&
        workflow.execution?.device_id &&
        workflow.execution.device_id !== this.#device.deviceId
      )
        return apiFailure(
          'execution_owned',
          '다른 PC가 이 작업을 이어서 처리하고 있습니다.',
        );
      const blockers = await this.#analysis.inspectRuntime();
      if (blockers.length)
        return apiFailure('runtime_unavailable', blockers.join(' '));
      let entry =
        (
          await readProcessJournal(
            this.#recovery,
            context,
            'notification-executions',
          )
        ).find(
          (item: RecoveryEntry): boolean => item.key === request.workflowId,
        ) ?? null;
      const previous = entry
        ? executionEntry.parse(JSON.parse(entry.payload))
        : null;
      if (workflow.state === 'complete' && workflow.execution?.job_id)
        return {
          ok: true,
          data: { workflow, jobId: workflow.execution.job_id, started: false },
        };
      let intent = previous ?? {
        workflowId: workflow.workflow_id,
        requestId: request.requestId,
        expectedRevision: request.expectedRevision,
        stage: 'claim',
        reclaim: false,
        priorClaimId: null,
      };
      if (
        workflow.execution &&
        (previous?.stage === 'started' ||
          (!previous && ['failed', 'stopped'].includes(workflow.state)))
      ) {
        if (workflow.execution.job_id) {
          const observed = await this.#analysis.inspectExecution({
            connectionId: request.connectionId,
            jobId: workflow.execution.job_id,
          });
          if (!observed.ok) return observed;
          if (!observed.data.mode)
            return apiFailure(
              'analysis_execution_blocked',
              observed.data.blockers.join(' '),
            );
        }
        if (workflow.revision !== request.expectedRevision)
          return apiFailure(
            'conflict',
            '현재 실행 상태를 다시 확인한 뒤 이어서 처리해 주세요.',
          );
        intent = {
          workflowId: workflow.workflow_id,
          requestId: stepId(
            request.requestId,
            `reclaim:${workflow.execution.claim_id}`,
          ),
          expectedRevision: request.expectedRevision,
          stage: 'claim',
          reclaim: true,
          priorClaimId: workflow.execution.claim_id,
        };
        entry = await writeProcessJournal(
          this.#recovery,
          context,
          'notification-executions',
          workflow.workflow_id,
          intent,
          entry?.revision ?? null,
        );
      }
      if (
        !workflow.execution ||
        (intent.reclaim &&
          intent.stage === 'claim' &&
          workflow.execution.claim_id === intent.priorClaimId)
      ) {
        if (!previous && workflow.revision !== request.expectedRevision)
          return apiFailure(
            'conflict',
            '승인 상태가 변경되었습니다. 다시 확인해 주세요.',
          );
        if (!entry)
          entry = await writeProcessJournal(
            this.#recovery,
            context,
            'notification-executions',
            workflow.workflow_id,
            intent,
          );
        const claimed = await this.#api(
          context,
          `notification-workflows/${workflow.workflow_id}/claim`,
          {
            request_id: intent.requestId,
            expected_revision: intent.expectedRevision,
            device_id: this.#device.deviceId,
            device_name: this.#device.deviceName,
            reclaim: intent.reclaim,
          },
        );
        if (!claimed.ok) {
          if (
            claimed.error.status &&
            claimed.error.status >= 400 &&
            claimed.error.status < 500
          )
            await removeProcessJournal(this.#recovery, context, entry);
          return claimed;
        }
        workflow = notificationMutationDataSchema.parse(claimed.value).workflow;
      }
      const execution = workflow.execution;
      if (!execution?.claim_id || execution.device_id !== this.#device.deviceId)
        return apiFailure(
          'execution_owned',
          '실행 기기를 확인하지 못했습니다.',
        );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      let jobId = execution.job_id;
      if (!jobId) {
        if (!workflow.target_document || !workflow.conversion_ref)
          return apiFailure(
            'approval_required',
            '승인한 원본과 저장 문서를 확인해 주세요.',
          );
        entry = await writeProcessJournal(
          this.#recovery,
          context,
          'notification-executions',
          workflow.workflow_id,
          { ...intent, stage: 'registration' },
          entry?.revision ?? null,
        );
        const source = workflow.source_ref;
        const registered = await this.#analysis.start(
          {
            connectionId: request.connectionId,
            sourceId: source.source_id,
            sourceVersion: source.source_version,
            sourceSha256: source.source_sha256,
            registrationRevision: source.registration_revision,
            targetDocument: workflow.target_document,
            registration: {
              requestId: workflow.resume_request_id,
              title: workflow.title.slice(0, 200),
              conversionRef: {
                conversionId: workflow.conversion_ref.conversion_id,
                conversionRevision: workflow.conversion_ref.conversion_revision,
              },
            },
            outputs: ['wiki', 'ontology'],
          },
          true,
          context,
        );
        if (!registered.ok) return registered;
        jobId = registered.data.job.job_id;
        const linked = await this.#api(
          context,
          `notification-workflows/${workflow.workflow_id}/execution`,
          {
            request_id: stepId(execution.claim_id, 'link'),
            expected_revision: workflow.revision,
            claim_id: execution.claim_id,
            job_id: jobId,
          },
        );
        if (!linked.ok) return linked;
        workflow = notificationMutationDataSchema.parse(linked.value).workflow;
      }
      const inspected = await this.#analysis.inspectExecution({
        connectionId: request.connectionId,
        jobId,
      });
      if (!inspected.ok) return inspected;
      if (!inspected.data.mode)
        return apiFailure(
          'analysis_execution_blocked',
          inspected.data.blockers.join(' '),
        );
      await writeProcessJournal(
        this.#recovery,
        context,
        'notification-executions',
        workflow.workflow_id,
        { ...intent, stage: 'started' },
        entry?.revision ?? null,
      );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      const started = await this.#analysis.execute(
        {
          connectionId: request.connectionId,
          jobId,
          expectedJobRevision: inspected.data.detail.job.job_revision,
          mode: inspected.data.mode,
          executionClaimId: execution.claim_id,
        },
        context,
      );
      if (!started.ok) return started;
      return { ok: true, data: { workflow, jobId, started: true } };
    } finally {
      finish();
    }
  }

  /** 보고에 고정된 원본에서 요청한 한 쪽만 제한 PNG로 반환합니다. */
  async page(
    request: NotificationPageRequest,
  ): Promise<NotificationPageResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const detail = await this.read(request);
    if (!detail.ok) return detail;
    // 원본 API가 고정 판본·실제 페이지 범위를 검증하므로 정상 페이지도 대조할 수 있습니다.
    const source = detail.data.workflow.source_ref;
    const query = new URLSearchParams({
      source_sha256: source.source_sha256,
      registration_revision: source.registration_revision,
      profile: context.selection.profile,
    });
    const url = `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/sources/${source.source_id}/versions/${source.source_version}/pages/${request.page}?${query.toString()}`;
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      const result = await readApiPageBytes(url, context.token, controller, {
        sourceSha256: source.source_sha256,
        sourceVersion: source.source_version,
        registrationRevision: source.registration_revision,
        page: request.page,
      });
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (!result.ok) {
        this.#connection.analysisAccessFailure(result);
        return result;
      }
      if (!(result.value instanceof Uint8Array))
        return apiFailure('invalid_response', '원본 쪽을 표시할 수 없습니다.');
      return {
        ok: true,
        data: {
          page: request.page,
          dataUrl: `data:image/png;base64,${Buffer.from(result.value).toString('base64')}`,
        },
      };
    } finally {
      this.#requests.delete(controller);
    }
  }
}
