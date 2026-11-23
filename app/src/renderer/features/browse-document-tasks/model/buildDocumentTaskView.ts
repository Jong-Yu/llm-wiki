import type { AnalysisDetail, AnalysisJob } from '@contracts/analysis.contract';
import type {
  DocumentConversionAttempt,
  DocumentTask,
} from '@contracts/documentTasks.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import type {
  DocumentTaskResult,
  DocumentTaskState,
  DocumentTaskStep,
  DocumentTaskStepState,
  DocumentTaskView,
} from './documentTask.types';

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

/** 다른 원본 판본의 변환 진행을 현재 작업의 결과로 표시하지 않습니다. */
function matchingConversion(
  task: DocumentTask,
  conversion: ConversionView | null,
): ConversionView | null {
  if (!conversion) return null;
  return conversion.source.sourceId === task.source.sourceId &&
    conversion.source.sourceVersion === task.source.sourceVersion &&
    conversion.source.sourceSha256 === task.source.sourceSha256 &&
    conversion.source.registrationRevision === task.source.registrationRevision
    ? conversion
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

/** 부분 결과는 저장 영수증·첫 본문 참조로 확인하며 추출 완료와 구별합니다. */
function savedResults(
  task: DocumentTask,
  detail: AnalysisDetail | null,
): DocumentTaskResult[] {
  const saved = new Map<string, DocumentTaskResult>();
  const first = detail?.job.conversion?.first_markdown;
  if (first)
    saved.set(first.document, {
      document: first.document,
      title: task.item.title,
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
      title:
        receipt.document === task.targetDocument
          ? task.item.title
          : receipt.document,
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
  if (progress.stage === 'download') return '원본을 읽고 있습니다';
  if (progress.stage === 'submit') return '변환 결과 보관 중';
  const unit =
    format === 'pdf'
      ? '쪽'
      : format === 'pptx' || format === 'ppt'
        ? '슬라이드'
        : '단위';
  return progress.total == null
    ? `${progress.completed}${unit} 처리 기록`
    : `${progress.completed} / ${progress.total}${unit} 처리 기록`;
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
  if (job) {
    if (
      job.result_summary.status === 'pending_reconcile' ||
      (detail?.receiptErrors.length ?? 0) > 0
    )
      return 'unconfirmed';
    if (
      detail?.local.status === 'running' ||
      job.lease_status === 'active' ||
      processing?.phase === 'running'
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
  if (conversion?.state === 'partial') return 'partial';
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

/** 사용자 설명에는 알려진 실패만 번역하고 원래 오류 코드는 처리 기록에 보존합니다. */
function failureMessage(conversion: ConversionView | null): string | null {
  const codes = conversion?.diagnosticCodes ?? [];
  const unread =
    conversion && 'reportSummary' in conversion
      ? conversion.reportSummary?.unreadRanges
      : conversion?.report?.unread_ranges;
  const workerFailed =
    codes.includes('worker_failed') ||
    unread?.some((value: string): boolean =>
      value.endsWith('source: worker_failed'),
    );
  if (workerFailed)
    return '변환 프로그램이 중단되어 나머지 원본을 읽지 못했습니다. 이 기록에는 구체적인 중단 원인이 남아 있지 않습니다.';
  return conversion?.message || null;
}

/** 현재 상태와 보존된 단계에 맞춰 실행 전·실패·미확정 설명을 작성합니다. */
function explanation(
  state: DocumentTaskState,
  converted: boolean,
  results: readonly DocumentTaskResult[],
  detail: AnalysisDetail | null,
  conversion: ConversionView | null,
  processing: DocumentTaskProcessingView | null,
): DocumentTaskView['explanation'] {
  if (state === 'unconfirmed')
    return {
      title: '처리 결과를 확인해야 합니다',
      body: '저장 완료 여부 또는 현재 작업 상태를 확인하지 못했습니다. 실패나 미저장으로 판단하지 않습니다.',
      next: '같은 요청의 결과를 먼저 확인합니다. 확인 전에는 새 변환·저장 요청을 만들지 않습니다.',
    };
  if (state === 'complete')
    return {
      title: '문서와 추출 결과가 저장됐습니다',
      body: '추출한 관계는 검토 전 상태입니다. 저장 완료가 내용의 정확성이나 전문가 승인을 뜻하지 않습니다.',
      next: '보존된 문서와 관계를 열어 확인할 수 있습니다.',
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
        failureMessage(conversion) ??
        '본문을 완전히 읽지 못했습니다. 등록한 원본은 보관되어 있습니다.',
      next: '다시 변환은 원본의 처음부터 시작합니다. 읽지 못한 부분이 남아 있으면 관계 추출을 진행하지 않습니다.',
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
      body: '등록한 원본은 보관되어 있습니다. 자동 실행 대기열에 등록된 상태는 아닙니다.',
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
      processing?.message ??
      detail?.local.message ??
      '작업 목록과 이 문서에서 같은 작업을 다시 열 수 있습니다.',
    next: '다른 화면으로 이동해도 작업은 이어집니다. 앱을 완전히 종료하면 이 기기의 실행은 중단될 수 있습니다.',
  };
}

/** 고정 원본의 저장 기록·실시간 상태를 UI 표시로만 합칩니다. */
export function buildDocumentTaskView(
  task: DocumentTask,
  options: DocumentTaskViewOptions = {},
): DocumentTaskView {
  const processing = options.processing ?? null;
  const detail = matchingAnalysis(
    task,
    options.analysis ?? processing?.detail ?? null,
  );
  const job = detail?.job ?? matchingJob(task, options.job ?? null);
  const conversion = matchingConversion(
    task,
    options.conversion ??
      processing?.conversion ??
      task.conversions.at(-1) ??
      null,
  );
  const state = taskState(
    task,
    detail,
    job,
    conversion,
    processing,
    options.readFailed === true,
  );
  const results = savedResults(task, detail);
  const plainText = task.item.format === 'md' || task.item.format === 'txt';
  const converted =
    plainText ||
    !!job ||
    (conversion?.state === 'complete' && conversion.receiptState === 'saved');
  const progress = conversionProgress(conversion, task.item.format);
  const current: DocumentTaskStepState =
    state === 'complete'
      ? 'complete'
      : state === 'running'
        ? 'current'
        : state === 'partial'
          ? 'failed'
          : state;
  const allSaved = job?.result_summary.status === 'complete';
  const ontologyRequested = job?.outputs.includes('ontology') ?? true;
  const cachedOnly =
    !job &&
    task.analysisSummary !== null &&
    task.registration.state === 'linked';
  const savedOntology = results.some(
    (result: DocumentTaskResult): boolean => result.ontology && result.current,
  );
  const steps: DocumentTaskStep[] = [
    { title: '원본 보관', state: 'complete', note: '등록한 원본 보관됨' },
    {
      title: '문자 변환',
      state: converted ? 'complete' : current,
      note: plainText
        ? '원문 문자 그대로 사용'
        : converted
          ? '본문 읽기 완료'
          : (progress ?? '처리량 기록 없음'),
    },
    {
      title: 'Wiki 저장',
      state: results.length > 0 ? 'complete' : converted ? current : 'waiting',
      note:
        results.length > 0
          ? '문서 보존됨'
          : state === 'unconfirmed'
            ? '저장 여부 확인 필요'
            : '저장 완료 전',
    },
    {
      title: '관계 추출',
      state: !ontologyRequested
        ? 'waiting'
        : allSaved && savedOntology
          ? 'complete'
          : results.length > 0
            ? current
            : 'waiting',
      note: !ontologyRequested
        ? '요청하지 않은 단계'
        : savedOntology
          ? '추출 완료 · 검토 전'
          : state === 'unconfirmed' && results.length > 0
            ? '저장 결과 확인 필요'
            : '미완료 단계',
    },
  ];
  const phase = !converted
    ? '문자 변환'
    : results.length === 0
      ? 'Wiki 저장'
      : '관계 추출';
  const statuses: Record<DocumentTaskState, string> = {
    ready: '실행 전',
    running: `${phase} 중`,
    failed: `${phase} 실패`,
    partial: '일부 완료 · 조치 필요',
    unconfirmed: '결과 확인 필요',
    complete: '처리 완료',
    stopped: '실행 중단',
  };
  let primaryAction: DocumentTaskView['primaryAction'] = null;
  if (!processing?.scopeInvalid) {
    if (state === 'unconfirmed')
      primaryAction = { id: 'refresh', label: '결과 확인' };
    else if (
      options.canWrite !== false &&
      !task.registration.jobId &&
      !detail
    ) {
      if (state === 'running' && conversion?.state === 'running')
        primaryAction = { id: 'stop-conversion', label: '이 기기 변환 중단' };
      else if (
        processing?.canRetryConversion ||
        (!processing &&
          !converted &&
          ['failed', 'partial', 'stopped'].includes(state))
      )
        primaryAction = { id: 'retry-conversion', label: '다시 변환' };
      else if (['ready', 'failed'].includes(state) && processing?.canPrepare)
        primaryAction = {
          id: 'prepare',
          label: converted ? '분석 접수 준비' : '본문 준비 시작',
        };
    }
  }
  const warnings =
    conversion && 'reportSummary' in conversion
      ? (conversion.reportSummary?.warnings ?? [])
      : (conversion?.report?.warnings ?? []);
  return {
    id: task.taskId,
    title: task.item.title,
    fileName: `${task.item.format.toUpperCase()} 원본`,
    sourceId: task.source.sourceId,
    sourceVersion: task.source.sourceVersion,
    updatedAt: task.updatedAt,
    attemptCount: task.conversions.length,
    state,
    status: cachedOnly
      ? `마지막 확인 · ${statuses[state]}`
      : allSaved && state === 'running'
        ? '저장 완료 · 후속 작업 중'
        : statuses[state],
    progress: !converted ? progress : null,
    jobId: detail?.job.job_id ?? task.registration.jobId,
    steps,
    explanation:
      state === 'complete' && !ontologyRequested
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
    primaryAction,
    attempts: task.conversions.map(
      (
        attempt: DocumentConversionAttempt,
        index: number,
      ): DocumentTaskView['attempts'][number] => ({
        id: attempt.requestId,
        title: `문자 변환 ${index + 1}회`,
        state: attempt.state,
        startedAt: attempt.startedAt,
        message: attempt.message,
        codes: [
          ...attempt.diagnosticCodes,
          ...(attempt.reportSummary?.unreadRanges ?? []),
        ],
      }),
    ),
  };
}
