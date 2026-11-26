import type { AnalysisDetail, AnalysisJob } from '@contracts/analysis.contract';
import type {
  DocumentConversionAttempt,
  DocumentTask,
} from '@contracts/documentTasks.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import { conversionNeedsTextReview } from '@contracts/sourceConversion.contract';
import { documentTaskPath } from '@renderer/shared/lib/workflowNavigation';
import { conversionFailureExplanation } from '@renderer/shared/lib/sourceConversionFailure';
import type { SourceConversionFailureExplanation } from '@renderer/shared/lib/sourceConversionFailure';
import type {
  DocumentTaskResult,
  DocumentTaskStage,
  DocumentTaskState,
  DocumentTaskView,
} from './documentTask.types';
import { buildDocumentProgress } from './documentTaskProgress';
import { conversionGapExplanation } from './conversionDiagnostics';

/** 상위 페이지가 같은 작업의 처리 세션을 조합할 때 전달하는 읽기 전용 입력입니다. */
export type DocumentTaskProcessingView = {
  busy: boolean;
  phase: string;
  message: string;
  error: string | null;
  conversion: SourceConversionRun | null;
  detail: AnalysisDetail | null;
  canRetryConversion: boolean;
  canPrepare: boolean;
  canExecute: boolean;
  canRefresh: boolean;
  scopeInvalid: boolean;
  document: string | null;
};
type DocumentTaskViewOptions = {
  processing?: DocumentTaskProcessingView | null;
  analysis?: AnalysisDetail | null;
  job?: AnalysisJob | null;
  conversion?: SourceConversionRun | null;
  readFailed?: boolean;
  canWrite?: boolean;
};
type ConversionView = SourceConversionRun | DocumentConversionAttempt;

/** 내용 보존과 AI 입력 한도를 구별하며 같은 입력의 반복 실행을 제안하지 않습니다. */
function inputSizeLimited(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    [
      'input_limit',
      'input_component_limit',
      'analysis_prompt_limit',
      'ai_input_limit',
    ].includes(code)
  );
}

/** 이미 저장된 결과를 유지하는 크기 한도 안내를 공통으로 사용합니다. */
function inputLimitGuidance(): DocumentTaskView['explanation'] {
  return {
    title: '분석할 수 있는 크기를 넘었습니다',
    body: '원본과 변환한 내용은 보관되어 있습니다. 현재 AI가 한 번에 읽을 수 있는 크기를 넘어 분석을 완료하지 못했습니다.',
    next: '필요한 범위의 원본으로 교체할 수 있습니다. 기존 원본과 결과는 유지됩니다.',
  };
}

/** 기존 기기 요약과 서버 보고의 문자 확인 경고를 같은 표시 기준으로 읽습니다. */
function textReviewScopes(conversion: ConversionView | null): string[] {
  if (conversion?.state !== 'partial' || conversion.receiptState !== 'saved')
    return [];
  const report =
    'reportSummary' in conversion
      ? conversion.reportSummary && {
          complete: conversion.reportSummary.complete,
          unread_ranges: conversion.reportSummary.unreadRanges,
          warnings: conversion.reportSummary.warnings,
        }
      : conversion.report;
  if (!report || !conversionNeedsTextReview(report)) return [];
  return [
    ...new Set(
      report.unread_ranges.map((range: string): string => {
        const scope = range.slice(0, range.indexOf(':'));
        return scope
          .replace(/^page (\d+)$/, '$1페이지')
          .replace(/^slide (\d+)$/, '$1슬라이드')
          .replace(/^frame (\d+)$/, '$1번째 프레임');
      }),
    ),
  ];
}

/** 현재 보고에 실제 포함된 문자만 경고 위치와 연결하며 누락 본문을 만들지 않습니다. */
function textReviewUnits(
  conversion: ConversionView | null,
  scopes: readonly string[],
): DocumentTaskView['textReviewUnits'] {
  if (!conversion || !('report' in conversion) || !conversion.report) return [];
  return conversion.report.units.flatMap(
    (
      unit: NonNullable<SourceConversionRun['report']>['units'][number],
    ): DocumentTaskView['textReviewUnits'] => {
      const location = unit.location;
      if (
        (location.kind !== 'pages' && location.kind !== 'slides') ||
        location.start !== location.end
      )
        return [];
      const label = scopes.find((scope: string): boolean =>
        location.kind === 'slides'
          ? scope === `${location.start}슬라이드`
          : scope === `${location.start}페이지` ||
            scope === `${location.start}번째 프레임`,
      );
      return label && unit.content ? [{ label, content: unit.content }] : [];
    },
  );
}

/** 저장된 시도 순서의 마지막 요청만 채택하고 다른 원본·이전 요청을 배제합니다. */
function matchingConversion(
  task: DocumentTask,
  conversion: ConversionView | null,
): ConversionView | null {
  if (!conversion) return null;
  const latest = task.conversions.at(-1);
  if (latest && latest.requestId !== conversion.requestId) return null;
  return conversion.source.sourceId === task.source.sourceId &&
    conversion.source.sourceVersion === task.source.sourceVersion &&
    conversion.source.sourceSha256 === task.source.sourceSha256 &&
    conversion.source.registrationRevision === task.source.registrationRevision
    ? conversion
    : null;
}

/** 이전 변환 세션의 단계·메시지·행동이 최신 저장 시도를 덮지 않게 합니다. */
function matchingProcessing(
  task: DocumentTask,
  processing: DocumentTaskProcessingView | null,
): DocumentTaskProcessingView | null {
  if (!processing) return null;
  if (processing.conversion)
    return matchingConversion(task, processing.conversion) ? processing : null;
  return task.conversions.length === 0 ||
    matchingAnalysis(task, processing.detail)
    ? processing
    : null;
}

/** 서로 다른 원본·접수 요청의 상세를 같은 작업에 섞지 않습니다. */
function matchingAnalysis(
  task: DocumentTask,
  detail: AnalysisDetail | null,
): AnalysisDetail | null {
  if (!detail) return null;
  return matchingJob(task, detail.job) ? detail : null;
}

/** 서버에서 확인한 작업과 고정 원본의 대응을 검사합니다. */
function matchingJob(
  task: DocumentTask,
  job: AnalysisJob | null,
): AnalysisJob | null {
  if (!job) return null;
  const source = job.source_ref;
  return (job.job_id === task.registration.jobId ||
    job.request_id === task.registration.requestId) &&
    source.source_id === task.source.sourceId &&
    source.source_version === task.source.sourceVersion &&
    source.source_sha256 === task.source.sourceSha256 &&
    source.registration_revision === task.source.registrationRevision
    ? job
    : null;
}

/** 같은 접수에서 채택한 내용은 다시 확인시키지 않되 다른 변환 보고는 해소하지 않습니다. */
function registrationUsesCurrentText(
  task: DocumentTask,
  job: AnalysisJob | null,
  conversion: ConversionView | null,
): boolean {
  const accepted = matchingJob(task, job);
  if (
    !accepted?.registration ||
    accepted.request_id !== task.registration.requestId ||
    accepted.targets.length !== 1 ||
    accepted.targets[0]?.document !== task.targetDocument
  )
    return false;
  const reference = conversion?.reference;
  return (
    !reference ||
    (accepted.registration.conversion_ref?.conversion_id ===
      reference.conversionId &&
      accepted.registration.conversion_ref.conversion_revision ===
        reference.conversionRevision)
  );
}

/** 부분 결과는 저장 영수증·첫 본문 참조로 확인하며 추출 완료와 구별합니다. */
function savedResults(
  title: string,
  targetDocument: string | null,
  detail: AnalysisDetail | null,
): DocumentTaskResult[] {
  const saved = new Map<string, DocumentTaskResult>();
  const first = detail?.job.conversion?.first_markdown;
  if (first)
    saved.set(first.document, {
      document: first.document,
      title,
      ontology: false,
      current: false,
    });
  for (const item of detail?.receipts ?? []) {
    if (item.state !== 'complete' || item.saved !== true || !item.receipt)
      continue;
    const receipt = item.receipt;
    const previous = saved.get(receipt.document);
    saved.set(receipt.document, {
      document: receipt.document,
      title: receipt.document === targetDocument ? title : receipt.document,
      ontology:
        previous?.ontology === true || receipt.stage === 'extract_ontology',
      current: item.current_output?.status === 'current',
    });
  }
  return [...saved.values()];
}

/** 변환의 실제 단위만 표시하며 전체 처리 완료율을 추정하지 않습니다. */
function conversionProgress(
  conversion: ConversionView | null,
  format: string,
): string | null {
  const progress = conversion?.progress;
  if (!progress) return null;
  if (
    progress.stage === 'submit' &&
    conversion.state !== 'running' &&
    conversion.state !== 'cancelling'
  )
    return null;
  if (progress.stage === 'download') return '원본을 읽고 있습니다';
  if (progress.stage === 'submit') return '변환 결과 보관 중';
  const unit =
    format === 'pdf'
      ? '페이지'
      : format === 'pptx' || format === 'ppt'
        ? '슬라이드'
        : '단위';
  return progress.total == null
    ? `${progress.completed}${unit} 처리 기록`
    : `${progress.completed} / ${progress.total}${unit} 처리 기록`;
}

/** 서버 작업 상태는 기기의 작업 색인이 없어도 같은 기준으로 표시합니다. */
function analysisState(
  detail: AnalysisDetail | null,
  job: AnalysisJob,
  running: boolean,
): DocumentTaskState {
  if (
    job.result_summary.status === 'pending_reconcile' ||
    (detail?.receiptErrors.length ?? 0) > 0
  )
    return 'unconfirmed';
  if (
    detail?.local.status === 'running' ||
    job.lease_status === 'active' ||
    running
  )
    return 'running';
  if (job.result_summary.status === 'complete') return 'complete';
  if (
    job.state === 'cancelled' ||
    detail?.local.status === 'stopped' ||
    job.reported_status === 'stopped'
  )
    return 'stopped';
  if (job.result_summary.status === 'partial') return 'partial';
  if (
    detail?.local.status === 'failed' ||
    job.reported_status === 'failed' ||
    job.reported_status === 'blocked' ||
    job.blockers.length > 0 ||
    job.result_summary.status === 'rejected'
  )
    return 'failed';
  return 'ready';
}

/** 실행 보고보다 저장 미확정·영수증을 먼저 보되 새 실행 중에는 이전 실패를 되살리지 않습니다. */
function taskState(
  task: DocumentTask,
  detail: AnalysisDetail | null,
  job: AnalysisJob | null,
  conversion: ConversionView | null,
  processing: DocumentTaskProcessingView | null,
  readFailed: boolean,
): DocumentTaskState {
  if (readFailed || processing?.scopeInvalid) return 'unconfirmed';
  if (job) return analysisState(detail, job, processing?.phase === 'running');
  if (task.analysisSummary && task.registration.state === 'linked') {
    const summary = task.analysisSummary;
    if (summary.resultStatus === 'pending_reconcile') return 'unconfirmed';
    if (summary.resultStatus === 'complete') return 'complete';
    if (summary.state === 'cancelled' || summary.reportedStatus === 'stopped')
      return 'stopped';
    if (summary.resultStatus === 'partial') return 'partial';
    if (
      ['blocked', 'failed'].includes(summary.reportedStatus ?? '') ||
      summary.basisStatus !== 'current' ||
      summary.resultStatus === 'rejected'
    )
      return 'failed';
    return 'unconfirmed';
  }
  if (
    task.registration.state === 'unconfirmed' ||
    task.registration.state === 'linked' ||
    processing?.phase === 'planning_unconfirmed'
  )
    return 'unconfirmed';
  if (
    conversion?.state === 'report_unconfirmed' ||
    conversion?.receiptState === 'unconfirmed' ||
    processing?.phase === 'conversion_unconfirmed'
  )
    return 'unconfirmed';
  if (
    conversion?.state === 'running' ||
    conversion?.state === 'cancelling' ||
    ['converting', 'planning', 'running'].includes(processing?.phase ?? '')
  )
    return 'running';
  if (conversion?.state === 'partial')
    return processing?.phase !== 'conversion_failed' &&
      textReviewScopes(conversion).length > 0
      ? 'review'
      : 'partial';
  if (
    conversion?.state === 'failed' ||
    task.registration.state === 'rejected' ||
    processing?.error
  )
    return 'failed';
  if (conversion?.state === 'cancelled' || processing?.phase === 'stopped')
    return 'stopped';
  return 'ready';
}

/** 별도로 보관된 미변환 구간을 읽어 진단 목록의 누락과 일반 경고를 구별합니다. */
function unreadRanges(conversion: ConversionView | null): readonly string[] {
  return conversion && 'reportSummary' in conversion
    ? (conversion.reportSummary?.unreadRanges ?? [])
    : (conversion?.report?.unread_ranges ?? []);
}

/** 실행 실패를 먼저 설명하고 부분 변환에서만 실제 미변환 사유를 안내합니다. */
function failureExplanation(
  conversion: ConversionView | null,
): SourceConversionFailureExplanation | null {
  const codes = conversion?.diagnosticCodes ?? [];
  const unread = unreadRanges(conversion);
  return (
    conversionFailureExplanation([...codes, ...unread]) ??
    (conversion?.state === 'partial' ? conversionGapExplanation(unread) : null)
  );
}

/** 현재 상태와 보존된 단계에 맞춰 실행 전·실패·미확정 설명을 작성합니다. */
function explanation(
  state: DocumentTaskState,
  converted: boolean,
  results: readonly DocumentTaskResult[],
  detail: AnalysisDetail | null,
  conversion: ConversionView | null,
  processing: DocumentTaskProcessingView | null,
  activeStep: DocumentTaskStage,
): DocumentTaskView['explanation'] {
  if (
    state === 'unconfirmed' &&
    conversion &&
    'canResumeUpload' in conversion &&
    conversion.canResumeUpload &&
    processing?.canRetryConversion
  )
    return {
      title: '변환 결과 저장을 이어갈 수 있습니다',
      body: '변환한 내용은 이 기기에 보관되어 있습니다. 서버에 저장되지 않은 부분부터 이어서 보냅니다.',
      next: '저장 계속을 선택하면 같은 요청의 결과를 먼저 확인하고 남은 내용을 보관합니다.',
    };
  if (state === 'unconfirmed')
    return {
      title: '처리 결과를 확인해야 합니다',
      body: '저장 완료 여부 또는 현재 작업 상태를 확인하지 못했습니다. 실패나 미저장으로 판단하지 않습니다.',
      next: '같은 요청의 결과를 먼저 확인합니다. 확인 전에는 새 변환·저장 요청을 만들지 않습니다.',
    };
  if (state === 'complete')
    return {
      title: '등록 완료',
      body: 'Wiki 문서와 온톨로지 저장을 확인했습니다.',
      next: '저장된 문서를 열어 확인할 수 있습니다.',
    };
  if (state === 'review')
    return {
      title: '변환된 문자를 확인해 주세요',
      body: '변환 문자는 보관됐습니다. 문자 인식의 신뢰도가 낮은 구간이 있어 원본과 대조해야 합니다.',
      next: '원본과 등록할 내용을 대조하고 필요한 내용을 수정해 주세요.',
    };
  if (state === 'stopped')
    return {
      title:
        detail?.job.state === 'cancelled'
          ? '분석 작업이 취소됐습니다'
          : '이 기기의 실행이 중단됐습니다',
      body: '보관한 원본과 이미 저장된 결과는 유지됩니다.',
      next:
        detail?.job.state === 'cancelled'
          ? '취소된 분석 작업은 다시 실행할 수 없습니다.'
          : converted
            ? '실행 조건과 저장 결과를 확인한 뒤 미완료 단계를 실행할 수 있습니다.'
            : '다시 변환하면 원본의 처음부터 읽습니다.',
    };
  if (!converted && (state === 'failed' || state === 'partial'))
    return {
      title:
        state === 'partial'
          ? '읽지 못한 원본이 남아 있습니다'
          : '문자 변환이 중단됐습니다',
      body:
        processing?.phase === 'conversion_failed' &&
        textReviewScopes(conversion).length > 0
          ? processing.message
          : (failureExplanation(conversion)?.body ??
            (state === 'partial'
              ? '원본의 일부를 문자로 변환하지 못했습니다. 등록한 원본과 읽은 내용은 보관되어 있습니다.'
              : '본문을 완전히 읽지 못했습니다. 이 기록에서는 구체적인 중단 원인을 확인하지 못했습니다. 등록한 원본은 보관되어 있습니다.')),
      next:
        failureExplanation(conversion)?.next ??
        (state === 'partial'
          ? '실행 기록과 원본을 확인해 주세요. 읽지 못한 범위와 실행 오류를 확인한 뒤 내용을 보완하거나 다시 변환할 수 있습니다.'
          : '실행 기록과 이 기기의 준비 상태를 먼저 확인해 주세요. 다시 변환하면 원본의 처음부터 읽으며 이전 결과는 유지됩니다.'),
    };
  if (state === 'partial' || state === 'failed')
    return {
      title:
        results.length > 0
          ? '저장된 문서와 미완료 단계가 있습니다'
          : '문서 처리를 완료하지 못했습니다',
      body:
        processing?.error ??
        detail?.local.message ??
        '현재 기준과 실행 조건을 확인해 주세요.',
      next: '보존된 결과는 유지하며 실행 조건을 확인한 뒤 미완료 단계를 실행합니다.',
    };
  if (state === 'ready')
    return {
      title: '문서 처리를 실행하기 전입니다',
      body: '등록한 원본은 보관되어 있습니다.',
      next: converted
        ? '실행 조건을 확인하고 실행을 선택하면 이 작업을 시작합니다.'
        : '본문 준비를 시작하면 원본에서 문자를 읽습니다.',
    };
  return {
    title:
      detail?.job.result_summary.status === 'complete'
        ? '저장 완료 · 후속 작업 진행 중'
        : !converted
          ? '원본에서 본문을 읽고 있습니다'
          : results.length === 0
            ? 'Wiki 문서를 준비하고 있습니다'
            : '관계를 추출하고 있습니다',
    body:
      activeStep === 'convert'
        ? '원본에서 등록할 내용을 읽고 있습니다.'
        : activeStep === 'wiki'
          ? '준비된 내용으로 Wiki 문서를 만들고 있습니다.'
          : '저장된 Wiki 문서에서 개념과 관계를 구성하고 있습니다.',
    next: '다른 화면으로 이동해도 작업은 이어집니다. 앱을 완전히 종료하면 이 기기의 실행은 중단될 수 있습니다.',
  };
}

/** 고정 원본의 저장 기록·실시간 상태를 UI 표시로만 합칩니다. */
export function buildDocumentTaskView(
  task: DocumentTask,
  options: DocumentTaskViewOptions = {},
): DocumentTaskView {
  const processing = matchingProcessing(task, options.processing ?? null);
  const scopeInvalid = options.processing?.scopeInvalid === true;
  const detail = matchingAnalysis(
    task,
    options.analysis ?? processing?.detail ?? null,
  );
  const job = detail?.job ?? matchingJob(task, options.job ?? null);
  const conversion =
    matchingConversion(task, options.conversion ?? null) ??
    matchingConversion(task, processing?.conversion ?? null) ??
    matchingConversion(task, task.conversions.at(-1) ?? null);
  const observedState = taskState(
    task,
    detail,
    job,
    conversion,
    processing,
    options.readFailed === true || scopeInvalid,
  );
  const results = savedResults(task.item.title, task.targetDocument, detail);
  const plainText = task.item.format === 'md' || task.item.format === 'txt';
  const converted =
    plainText ||
    !!job ||
    (conversion?.state === 'complete' && conversion.receiptState === 'saved');
  const progress = conversionProgress(conversion, task.item.format);
  const reviewScopes =
    scopeInvalid ||
    processing?.phase === 'conversion_failed' ||
    registrationUsesCurrentText(task, job, conversion)
      ? []
      : textReviewScopes(conversion);
  const stageView = buildDocumentProgress({
    state: observedState,
    detail,
    job,
    targets: [task.targetDocument],
    inputReady: converted,
    conversionKnown: true,
    conversion,
    conversionContentGap:
      !!conversionGapExplanation(unreadRanges(conversion)) &&
      !conversionFailureExplanation([
        ...(conversion?.diagnosticCodes ?? []),
        ...unreadRanges(conversion),
      ]),
    format: task.item.format,
  });
  const { state } = stageView;
  const inputLimited =
    state !== 'complete' &&
    (inputSizeLimited(task.registration.errorCode) ||
      inputSizeLimited(detail?.local.failureCode));
  const ontologyRequested = job?.outputs.includes('ontology') ?? true;
  const cachedOnly =
    !job &&
    task.analysisSummary !== null &&
    task.registration.state === 'linked';
  let primaryAction: DocumentTaskView['primaryAction'] = null;
  if (!scopeInvalid && !inputLimited) {
    if (state === 'unconfirmed')
      primaryAction =
        options.canWrite !== false &&
        !task.registration.jobId &&
        task.registration.state !== 'unconfirmed' &&
        conversion &&
        'canResumeUpload' in conversion &&
        conversion.canResumeUpload &&
        processing?.canRetryConversion
          ? { id: 'retry-conversion', label: '저장 계속' }
          : { id: 'refresh', label: '결과 확인' };
    else if (
      options.canWrite !== false &&
      !task.registration.jobId &&
      !detail
    ) {
      if (state === 'running' && conversion?.state === 'running')
        primaryAction = { id: 'stop-conversion', label: '문자 변환 중단' };
      else if (
        state !== 'review' &&
        (processing?.canRetryConversion ||
          (!processing &&
            !converted &&
            ['failed', 'partial', 'stopped'].includes(state)))
      )
        primaryAction = { id: 'retry-conversion', label: '다시 변환' };
      else if (['ready', 'failed'].includes(state) && processing?.canPrepare)
        primaryAction = {
          id: 'prepare',
          label: converted ? 'Wiki 생성 시작' : '문자 변환 시작',
        };
    }
  }
  if (
    !scopeInvalid &&
    !inputLimited &&
    options.canWrite !== false &&
    processing?.canExecute &&
    job &&
    job.state !== 'cancelled' &&
    !['running', 'complete', 'unconfirmed'].includes(state)
  )
    primaryAction = {
      id: 'execute',
      label:
        stageView.activeStep === 'ontology'
          ? '온톨로지 재개'
          : 'Wiki 생성 재개',
    };
  const warnings =
    conversion && 'reportSummary' in conversion
      ? (conversion.reportSummary?.warnings ?? [])
      : (conversion?.report?.warnings ?? []);
  return {
    id: task.taskId,
    inputLimited,
    detailPath: documentTaskPath(task.taskId),
    title: task.item.title,
    fileName: `${task.item.format.toUpperCase()} 원본`,
    sourceId: task.source.sourceId,
    sourceVersion: task.source.sourceVersion,
    updatedAt: task.updatedAt,
    attemptCount: task.conversions.length,
    ...stageView,
    status: cachedOnly ? `마지막 확인 · ${stageView.status}` : stageView.status,
    progress: !converted ? progress : null,
    jobId: detail?.job.job_id ?? task.registration.jobId,
    explanation: inputLimited
      ? inputLimitGuidance()
      : state === 'complete' && !ontologyRequested
        ? {
            title: 'Wiki 문서가 저장됐습니다',
            body: '이번 작업은 문서 저장까지 요청했습니다.',
            next: '보존된 문서를 열어 확인할 수 있습니다.',
          }
        : explanation(
            state,
            converted,
            results,
            detail,
            conversion,
            processing,
            stageView.activeStep,
          ),
    results,
    hasPreviousResults:
      job?.result_summary.results.some(
        (result: AnalysisJob['result_summary']['results'][number]): boolean =>
          result.saved === true && result.current_run === false,
      ) ?? false,
    warnings: conversion?.historyWarning
      ? [...warnings, conversion.historyWarning]
      : warnings,
    textReviewScopes: reviewScopes,
    textReviewUnits: textReviewUnits(conversion, reviewScopes),
    primaryAction,
    attempts: task.conversions.map(
      (
        attempt: DocumentConversionAttempt,
        index: number,
      ): DocumentTaskView['attempts'][number] => ({
        id: attempt.requestId,
        title: `문자 변환 ${index + 1}회`,
        state:
          textReviewScopes(attempt).length > 0
            ? '문자 확인 필요'
            : attempt.state,
        startedAt: attempt.startedAt,
        message:
          textReviewScopes(attempt).length > 0
            ? '변환 문자는 보관됐습니다. 문자 인식의 신뢰도가 낮은 구간을 원본과 대조해 주세요.'
            : attempt.message,
        codes: [
          ...attempt.diagnosticCodes,
          ...(attempt.reportSummary?.unreadRanges ?? []),
          ...(attempt.reportSummary?.warnings ?? []),
        ],
      }),
    ),
  };
}

/** 다른 기기의 서버 작업도 같은 상세로 읽으며 없는 변환 시도는 만들지 않습니다. */
export function buildAnalysisProgressView(
  detail: AnalysisDetail,
  canWrite: boolean = false,
): DocumentTaskView {
  const job = detail.job;
  const targets = job.targets.map(
    (target: AnalysisJob['targets'][number]): string => target.document,
  );
  const target = targets[0] ?? null;
  const title = job.registration?.title ?? target ?? '문서 처리';
  const results = savedResults(title, target, detail);
  const progress = buildDocumentProgress({
    state: analysisState(detail, job, false),
    detail,
    job,
    targets,
    inputReady: true,
    conversionKnown: job.conversion?.complete === true,
    conversion: null,
    format: '',
  });
  const inputLimited =
    progress.state !== 'complete' && inputSizeLimited(detail.local.failureCode);
  const guidance = inputLimited
    ? inputLimitGuidance()
    : explanation(
        progress.state,
        true,
        results,
        detail,
        null,
        null,
        progress.activeStep,
      );
  return {
    id: job.job_id,
    inputLimited,
    detailPath: `/documents?${new URLSearchParams({ jobId: job.job_id })}`,
    title,
    fileName: '저장된 입력',
    sourceId: job.source_ref.source_id,
    sourceVersion: job.source_ref.source_version,
    updatedAt: job.created_at,
    attemptCount: 0,
    jobId: job.job_id,
    ...progress,
    progress: null,
    explanation: {
      ...guidance,
      next:
        progress.state === 'running'
          ? '문서 목록에서 같은 작업의 진행과 저장 결과를 다시 확인할 수 있습니다.'
          : canWrite && progress.state === 'ready'
            ? '등록 계속을 선택하면 다음 단계를 시작합니다.'
            : guidance.next,
    },
    results,
    hasPreviousResults: job.result_summary.results.some(
      (result: AnalysisJob['result_summary']['results'][number]): boolean =>
        result.saved === true && result.current_run === false,
    ),
    attempts: [],
    warnings: [],
    textReviewScopes: [],
    textReviewUnits: [],
    // 쓰기 권한만으로 실행 준비를 추정하지 않습니다. 조회는 항상 새 실행과 분리합니다.
    primaryAction:
      progress.state === 'unconfirmed'
        ? { id: 'refresh', label: '결과 확인' }
        : null,
  };
}
