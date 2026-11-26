import { sourceConversionRunSchema } from '@contracts/sourceConversion.contract';
import assert from 'node:assert/strict';
import {
  buildDocumentTaskView,
  buildAnalysisProgressView,
} from '@renderer/features/browse-document-tasks/model/buildDocumentTaskView';
import { conversionFailureExplanation } from '@renderer/shared/lib/sourceConversionFailure';
import {
  conversionDiagnosticMessages,
  conversionGapExplanation,
} from '@renderer/features/browse-document-tasks/model/conversionDiagnostics';
import { documentTaskNeedsAttention } from '@renderer/features/browse-document-tasks/model/documentTask.types';
import {
  fixtureAnalysis,
  fixtureCompleteAnalysis,
  fixturePresentationTask,
  fixtureTask,
} from './fixtures';

const task = fixtureTask();
const unchanged = JSON.stringify(task);
const failed = buildDocumentTaskView(task);
assert.equal(failed.state, 'failed');
assert.equal(failed.primaryAction?.id, 'retry-conversion');
assert.match(failed.explanation.body, /구체적인 중단 원인/);
assert.equal(failed.progress, '4 / 170페이지 처리 기록');
assert.equal(failed.results.length, 0);
assert.equal(documentTaskNeedsAttention(failed), true);
assert.equal(JSON.stringify(task), unchanged);
assert.equal(
  buildDocumentTaskView(task, { canWrite: false }).primaryAction,
  null,
);
console.log(
  'PASS worker failure remains actionable and preserves source/attempt records',
);

const presentation = fixturePresentationTask();
const preservedPresentation = JSON.stringify(presentation);
const presentationView = buildDocumentTaskView(presentation);
assert.equal(presentationView.state, 'partial');
assert.equal(presentationView.status, '변환 내용 확인 필요');
assert.equal(presentationView.steps[0]?.state, 'review');
assert.match(presentationView.explanation.body, /연결선/);
assert.match(presentationView.explanation.body, /레이아웃·마스터/);
assert.match(presentationView.explanation.next, /대조.*보완/);
assert.doesNotMatch(presentationView.explanation.body, /중단 원인/);
assert.equal(JSON.stringify(presentation), preservedPresentation);
assert.equal(
  conversionDiagnosticMessages(presentationView.attempts[0]?.codes ?? [])
    .length,
  6,
);
assert.deepEqual(
  conversionDiagnosticMessages(['unknown_code', 'pypdf_6.21.2']),
  [],
);
assert.equal(
  conversionGapExplanation(['slide 1: small_picture_not_ocr']),
  null,
);
assert.equal(
  conversionGapExplanation([
    'slide 1: picture_content_not_read',
    'remaining source: unknown_error',
  ]),
  null,
);
for (const [code, message] of [
  ['parser_failed', /원본을 읽는 중/],
  ['conversion_output_or_archive_limit', /처리할 수 있는 범위/],
  ['dependency_missing:pypdf', /구성 요소/],
] as const) {
  const mixed = fixturePresentationTask();
  const mixedAttempt = mixed.conversions[0];
  assert.ok(mixedAttempt?.reportSummary);
  mixedAttempt.reportSummary.unreadRanges.push(`remaining source: ${code}`);
  const mixedView = buildDocumentTaskView(mixed);
  assert.match(mixedView.explanation.body, message);
  assert.equal(mixedView.status, '문자 변환 중단');
}
const presentationAttempt = presentation.conversions[0];
assert.ok(presentationAttempt?.reportSummary);
presentationAttempt.reportSummary.unreadRanges.push(
  'remaining source: conversion_memory_failed',
);
assert.match(buildDocumentTaskView(presentation).explanation.body, /메모리/);
assert.match(
  conversionFailureExplanation(['remaining source: conversion_idle_timeout'])
    ?.body ?? '',
  /새 진행/,
);
presentationAttempt.state = 'complete';
presentationAttempt.reportSummary.complete = true;
presentationAttempt.reportSummary.unreadRanges = [];
assert.equal(buildDocumentTaskView(presentation).state, 'ready');
presentationAttempt.state = 'failed';
assert.match(
  buildDocumentTaskView(presentation).explanation.body,
  /구체적인 중단 원인/,
);
console.log(
  'PASS VOC content gaps use retained ranges; warnings never imply execution failure or resolve missing content',
);

const unconfirmedTask = structuredClone(task);
unconfirmedTask.registration.state = 'unconfirmed';
const unconfirmed = buildDocumentTaskView(unconfirmedTask);
assert.equal(unconfirmed.state, 'unconfirmed');
assert.equal(unconfirmed.primaryAction?.id, 'refresh');
assert.match(unconfirmed.explanation.body, /미저장으로 판단하지/);
console.log(
  'PASS uncertain registration never exposes conversion or analysis rerun',
);

const linkedTask = structuredClone(task);
const detail = fixtureAnalysis(task);
linkedTask.registration.state = 'linked';
linkedTask.registration.jobId = detail.job.job_id;
const partial = buildDocumentTaskView(linkedTask, { analysis: detail });
assert.equal(partial.state, 'partial');
assert.equal(partial.results[0]?.document, task.targetDocument);
assert.equal(partial.steps[1]?.state, 'complete');
assert.equal(partial.steps[2]?.state, 'failed');
assert.equal(partial.hasPreviousResults, false);
assert.equal(partial.primaryAction, null);
const live = structuredClone(detail);
live.local.status = 'running';
assert.equal(
  buildDocumentTaskView(linkedTask, { analysis: live }).state,
  'running',
);
assert.equal(
  buildDocumentTaskView(linkedTask, {
    analysis: detail,
    processing: {
      busy: false,
      phase: 'running',
      message: '실행 중',
      error: null,
      conversion: null,
      detail: live,
      canRetryConversion: false,
      canPrepare: false,
      canExecute: false,
      canRefresh: true,
      scopeInvalid: false,
      document: task.targetDocument,
    },
  }).state,
  'running',
);
console.log(
  'PASS saved Wiki survives extraction failure and new local run overrides stale failure',
);

const pending = structuredClone(detail);
pending.receiptErrors = [
  { requestId: '1'.repeat(32), message: '응답 확인 필요' },
];
const pendingView = buildDocumentTaskView(linkedTask, { analysis: pending });
assert.equal(pendingView.state, 'unconfirmed');
assert.equal(pendingView.primaryAction?.id, 'refresh');
assert.equal(pendingView.results[0]?.document, task.targetDocument);
const unrelated = structuredClone(detail);
unrelated.job.source_ref.source_version = '9'.repeat(32);
const unrelatedView = buildDocumentTaskView(linkedTask, {
  analysis: unrelated,
});
assert.equal(unrelatedView.state, 'unconfirmed');
assert.equal(unrelatedView.results.length, 0);
console.log(
  'PASS receipt uncertainty retains confirmed results, unrelated source version is excluded',
);

linkedTask.analysisSummary = {
  state: 'claimed',
  reportedStatus: null,
  resultStatus: 'complete',
  basisStatus: 'current',
  updatedAt: linkedTask.updatedAt,
};
assert.match(buildDocumentTaskView(linkedTask).status, /^마지막 확인/);
assert.equal(
  buildDocumentTaskView(linkedTask, { job: detail.job }).state,
  'partial',
);
assert.equal(
  buildDocumentTaskView(linkedTask, { readFailed: true }).state,
  'unconfirmed',
);
const cancelled = structuredClone(detail);
cancelled.job.state = 'cancelled';
assert.equal(
  buildDocumentTaskView(linkedTask, { analysis: cancelled }).state,
  'stopped',
);
assert.equal(
  buildDocumentTaskView(linkedTask, { analysis: cancelled }).primaryAction,
  null,
);
console.log(
  'PASS current server status overrides cached success and cancellation exposes no restart',
);

const earlier = structuredClone(task);
const previous = structuredClone(earlier.conversions[0]);
assert.ok(previous);
previous.requestId = '1'.repeat(32);
previous.state = 'complete';
earlier.conversions.unshift(previous);
const retryView = buildDocumentTaskView(earlier);
assert.equal(retryView.state, 'failed');
assert.equal(retryView.attemptCount, 2);
assert.equal(retryView.attempts[0]?.state, 'complete');
console.log(
  'PASS latest failed conversion does not erase earlier attempt or appear complete',
);

const runningConversion = fixtureTask();
const attempt = runningConversion.conversions[0];
assert.ok(attempt);
attempt.state = 'running';
attempt.receiptState = 'pending';
attempt.historyWarning = '로컬 작업 기록 갱신을 확인하지 못했습니다.';
const runningConversionView = buildDocumentTaskView(runningConversion);
assert.equal(runningConversionView.primaryAction?.id, 'stop-conversion');
assert.equal(runningConversionView.state, 'running');
assert.deepEqual(runningConversionView.warnings, [attempt.historyWarning]);
assert.equal(
  buildDocumentTaskView(runningConversion, { canWrite: false }).primaryAction,
  null,
);
console.log(
  'PASS local conversion stop is explicit and journal warning does not overwrite execution status',
);

const rejected = fixtureTask();
rejected.item.format = 'md';
rejected.conversions = [];
rejected.registration.state = 'rejected';
const rejectedView = buildDocumentTaskView(rejected, {
  processing: {
    busy: false,
    phase: 'ready',
    message: '접수 준비',
    error: null,
    conversion: null,
    detail: null,
    canRetryConversion: false,
    canPrepare: true,
    canExecute: false,
    canRefresh: true,
    scopeInvalid: false,
    document: null,
  },
});
assert.equal(rejectedView.state, 'failed');
assert.equal(rejectedView.primaryAction?.id, 'prepare');
console.log(
  'PASS definite registration rejection can be prepared again without reconverting text',
);

const measured = buildDocumentTaskView(runningConversion);
assert.deepEqual(measured.measurement, {
  completed: 4,
  total: 170,
  percent: 2,
  remaining: 166,
  unit: '페이지',
});
assert.equal(measured.completedStepCount, 0);
assert.equal(measured.steps.length, 3);
for (const stage of ['download', 'submit'] as const) {
  const otherStage = structuredClone(runningConversion);
  const record = otherStage.conversions[0];
  assert.ok(record);
  record.progress = { stage, completed: 170, total: 170 };
  assert.equal(buildDocumentTaskView(otherStage).measurement, null);
}
for (const total of [null, 0, 3]) {
  const unknownTotal = structuredClone(runningConversion);
  const record = unknownTotal.conversions[0];
  assert.ok(record);
  record.progress = { stage: 'convert', completed: 4, total };
  const display = buildDocumentTaskView(unknownTotal).measurement;
  assert.equal(display?.completed, 4);
  assert.equal(display?.total, null);
  assert.equal(display?.percent, null);
  assert.equal(display?.remaining, null);
}
const zero = structuredClone(runningConversion);
assert.ok(zero.conversions[0]);
zero.conversions[0].progress = { stage: 'convert', completed: 0, total: 170 };
assert.equal(buildDocumentTaskView(zero).measurement?.percent, 0);
console.log(
  'PASS measured conversion only: unknown/invalid totals and transfer stages never invent a percentage',
);

const completeDetail = fixtureCompleteAnalysis(linkedTask);
const completeView = buildDocumentTaskView(linkedTask, {
  analysis: completeDetail,
});
assert.equal(completeView.state, 'complete');
assert.equal(completeView.completedStepCount, 3);
assert.equal(completeView.status, '등록 완료');
assert.equal(completeView.measurement, null);
for (const status of ['changed', 'unavailable'] as const) {
  const staleReceipt = structuredClone(completeDetail);
  assert.ok(staleReceipt.receipts[1]);
  staleReceipt.receipts[1].current_output = { status };
  const view = buildDocumentTaskView(linkedTask, { analysis: staleReceipt });
  assert.equal(view.state, 'unconfirmed');
  assert.equal(view.steps[2]?.state, 'unconfirmed');
  assert.equal(view.completedStepCount, 2);
  assert.equal(view.results.length, 1);
}
const wrongTarget = structuredClone(completeDetail);
assert.ok(wrongTarget.receipts[0]?.receipt);
wrongTarget.receipts[0].receipt.document = '다른 문서.md';
const wrongTargetView = buildDocumentTaskView(linkedTask, {
  analysis: wrongTarget,
});
assert.equal(wrongTargetView.steps[1]?.state, 'unconfirmed');
assert.equal(wrongTargetView.state, 'unconfirmed');
const noReceipt = structuredClone(completeDetail);
noReceipt.receipts = [];
assert.equal(
  buildDocumentTaskView(linkedTask, { analysis: noReceipt }).state,
  'unconfirmed',
);
const oldOutput = structuredClone(detail);
assert.ok(oldOutput.receipts[0]);
oldOutput.receipts[0].current_output = { status: 'changed' };
const oldOutputView = buildDocumentTaskView(linkedTask, {
  analysis: oldOutput,
});
assert.equal(oldOutputView.results.length, 1);
assert.equal(oldOutputView.steps[1]?.state, 'failed');
assert.equal(oldOutputView.completedStepCount, 1);
console.log(
  'PASS only current target receipts complete stages; summary/old/other-document results remain read-only evidence',
);

const activeOntology = structuredClone(detail);
activeOntology.local.status = 'running';
activeOntology.job.active_input_ref = {
  bundle_id: '1'.repeat(32),
  bundle_revision: 'e'.repeat(64),
  stage: 'extract_ontology',
};
const ontologyView = buildDocumentTaskView(linkedTask, {
  analysis: activeOntology,
});
assert.equal(ontologyView.status, '온톨로지 구성 중');
assert.equal(ontologyView.measurement, null);
assert.equal(ontologyView.steps[1]?.state, 'complete');
const missingWikiProof = structuredClone(activeOntology);
missingWikiProof.receipts = [];
assert.equal(
  buildDocumentTaskView(linkedTask, { analysis: missingWikiProof }).steps[1]
    ?.state,
  'unconfirmed',
);
assert.equal(
  buildDocumentTaskView(linkedTask, { analysis: missingWikiProof }).activeStep,
  'ontology',
);
const serverOnly = buildAnalysisProgressView(activeOntology, true);
assert.equal(serverOnly.status, '온톨로지 구성 중');
assert.equal(serverOnly.steps[0]?.state, 'unavailable');
assert.equal(serverOnly.completedStepCount, 1);
assert.equal(serverOnly.measurement, null);
assert.equal(serverOnly.primaryAction, null);
assert.equal(serverOnly.detailPath, `/documents?jobId=${detail.job.job_id}`);
const serverComplete = buildAnalysisProgressView(completeDetail);
assert.equal(serverComplete.state, 'complete');
assert.equal(serverComplete.completedStepCount, 2);
assert.equal(serverComplete.completionLabel, '확인된 2단계 완료');
console.log(
  'PASS server-only records preserve real stage and return address without fabricated local conversion',
);

const oldSession = {
  busy: false,
  phase: 'complete',
  message: '예전 완료',
  error: null,
  conversion: null,
  detail: completeDetail,
  canRetryConversion: false,
  canPrepare: false,
  canExecute: true,
  canRefresh: true,
  scopeInvalid: false,
  document: task.targetDocument,
};
const newer = structuredClone(task);
newer.registration.requestId = '7'.repeat(32);
newer.registration.jobId = null;
assert.equal(
  buildDocumentTaskView(newer, { processing: oldSession }).state,
  'failed',
);
assert.equal(
  buildDocumentTaskView(newer, { processing: oldSession }).completedStepCount,
  0,
);
const resumable = buildDocumentTaskView(linkedTask, {
  analysis: detail,
  processing: { ...oldSession, detail, phase: 'partial' },
});
assert.equal(resumable.primaryAction?.id, 'execute');
assert.equal(resumable.primaryAction?.label, '온톨로지 재개');
assert.equal(
  buildDocumentTaskView(linkedTask, {
    analysis: detail,
    processing: { ...oldSession, detail, phase: 'partial' },
    canWrite: false,
  }).primaryAction,
  null,
);
console.log(
  'PASS stale sessions cannot complete current stages; resume requires actual executable state and write permission',
);

const reviewedTask = fixtureTask();
const reviewedAttempt = reviewedTask.conversions[0];
assert.ok(reviewedAttempt);
const lowConfidenceCode =
  'ocr_low_or_missing_confidence_text_retained_manual_review_required';
const slideTask = fixturePresentationTask();
const slideAttempt = slideTask.conversions[0];
assert.ok(slideAttempt);
const reviewSlides = [121, 122, 124, 128, 136];
slideAttempt.reportSummary = {
  complete: false,
  unreadRanges: reviewSlides.map(
    (slide: number): string => `slide ${slide}: ${lowConfidenceCode}`,
  ),
  warnings: [lowConfidenceCode],
};
slideAttempt.diagnosticCodes = [lowConfidenceCode];
const slideConversion = sourceConversionRunSchema.parse({
  ...slideAttempt,
  source: slideTask.source,
  format: 'pptx',
  report: {
    method: 'pptx_text',
    complete: false,
    unread_ranges: slideAttempt.reportSummary.unreadRanges,
    warnings: [lowConfidenceCode],
    units: reviewSlides.map((slide: number) => ({
      unit_id: `slide-${slide}`,
      location: { kind: 'slides', start: slide, end: slide },
      content: `보관한 ${slide}슬라이드 문자`,
    })),
    origin: 'client_reported',
    coverage: 'reported_units_only',
    original_coverage: 'not_verified',
    semantic_validation: 'not_run',
  },
  reference: null,
  cleanupWarning: false,
});
const slideView = buildDocumentTaskView(slideTask, {
  conversion: slideConversion,
});
assert.equal(slideView.state, 'review');
assert.deepEqual(
  slideView.textReviewScopes,
  reviewSlides.map((slide: number): string => `${slide}슬라이드`),
);
assert.deepEqual(
  slideView.textReviewUnits,
  reviewSlides.map((slide: number) => ({
    label: `${slide}슬라이드`,
    content: `보관한 ${slide}슬라이드 문자`,
  })),
);
assert.notEqual(slideView.primaryAction?.id, 'retry-conversion');
assert.deepEqual(
  buildDocumentTaskView(slideTask).textReviewScopes,
  slideView.textReviewScopes,
);
reviewedAttempt.state = 'partial';
reviewedAttempt.diagnosticCodes = [lowConfidenceCode];
reviewedAttempt.reportSummary = {
  complete: false,
  unreadRanges: [`page 6: ${lowConfidenceCode}`],
  warnings: [lowConfidenceCode],
};
assert.equal(buildDocumentTaskView(reviewedTask).textReviewScopes.length, 1);
const reviewedDetail = fixtureAnalysis(reviewedTask);
reviewedTask.registration.jobId = reviewedDetail.job.job_id;
reviewedTask.registration.state = 'linked';
const originalReviewedTask = JSON.stringify(reviewedTask);
const acceptedReview = buildDocumentTaskView(reviewedTask, {
  analysis: reviewedDetail,
});
assert.deepEqual(acceptedReview.textReviewScopes, []);
assert.deepEqual(acceptedReview.textReviewUnits, []);
assert.deepEqual(acceptedReview.warnings, [lowConfidenceCode]);
assert.ok(acceptedReview.attempts[0]?.codes.includes(lowConfidenceCode));
assert.equal(JSON.stringify(reviewedTask), originalReviewedTask);
for (const mismatch of ['source', 'request', 'target', 'registration']) {
  const other = structuredClone(reviewedDetail);
  if (mismatch === 'source')
    other.job.source_ref.source_version = '9'.repeat(32);
  if (mismatch === 'request') other.job.request_id = '9'.repeat(32);
  if (mismatch === 'target') {
    const target = other.job.targets[0];
    assert.ok(target);
    target.document = '다른 대상.md';
  }
  if (mismatch === 'registration') other.job.registration = null;
  assert.equal(
    buildDocumentTaskView(reviewedTask, { analysis: other }).textReviewScopes
      .length,
    1,
    mismatch,
  );
}
reviewedAttempt.reference = {
  ...reviewedTask.source,
  requestId: reviewedAttempt.requestId,
  conversionId: '4'.repeat(32),
  conversionRevision: '5'.repeat(64),
};
assert.equal(
  buildDocumentTaskView(reviewedTask, { analysis: reviewedDetail })
    .textReviewScopes.length,
  1,
);
assert.ok(reviewedDetail.job.registration);
reviewedDetail.job.registration.conversion_ref = {
  conversion_id: reviewedAttempt.reference.conversionId,
  conversion_revision: reviewedAttempt.reference.conversionRevision,
};
assert.deepEqual(
  buildDocumentTaskView(reviewedTask, { analysis: reviewedDetail })
    .textReviewScopes,
  [],
);
reviewedDetail.job.registration.conversion_ref.conversion_revision = '6'.repeat(
  64,
);
assert.equal(
  buildDocumentTaskView(reviewedTask, { analysis: reviewedDetail })
    .textReviewScopes.length,
  1,
);
console.log(
  'PASS accepted source/target/request/report resolves current text review only; mismatches preserve review and original warnings',
);

const resumableUpload = sourceConversionRunSchema.parse({
  requestId: 'f'.repeat(32),
  source: task.source,
  state: 'report_unconfirmed',
  format: 'pdf',
  progress: { stage: 'submit', completed: 0, total: 1 },
  report: null,
  receiptState: 'unconfirmed',
  reference: null,
  message: '변환 결과 보관 필요',
  diagnosticCodes: [],
  cleanupWarning: false,
  canResumeUpload: true,
});
const uploadProcessing = {
  ...oldSession,
  phase: 'conversion_unconfirmed',
  conversion: resumableUpload,
  detail: null,
  canRetryConversion: true,
  canExecute: false,
};
const uploadView = buildDocumentTaskView(task, {
  processing: uploadProcessing,
  conversion: resumableUpload,
});
assert.equal(uploadView.primaryAction?.label, '저장 계속');
assert.match(uploadView.explanation.body, /저장되지 않은 부분부터/);
assert.equal(
  buildDocumentTaskView(task, {
    processing: uploadProcessing,
    conversion: resumableUpload,
    canWrite: false,
  }).primaryAction?.id,
  'refresh',
);
assert.equal(
  buildDocumentTaskView(unconfirmedTask, {
    processing: uploadProcessing,
    conversion: resumableUpload,
  }).primaryAction?.id,
  'refresh',
);
assert.equal(
  buildDocumentTaskView(task, {
    processing: {
      ...uploadProcessing,
      conversion: { ...resumableUpload, canResumeUpload: false },
    },
    conversion: { ...resumableUpload, canResumeUpload: false },
  }).primaryAction?.id,
  'refresh',
);
console.log(
  'PASS verified upload continuation uses the same conversion; other receipt/access uncertainties stay read-only',
);

const limitedTask = structuredClone(task);
limitedTask.registration.state = 'rejected';
limitedTask.registration.errorCode = 'input_limit';
const limitedView = buildDocumentTaskView(limitedTask);
assert.equal(limitedView.inputLimited, true);
assert.equal(limitedView.primaryAction, null);
assert.match(limitedView.explanation.body, /보관되어 있습니다/);
assert.match(limitedView.explanation.next, /교체/);
console.log(
  'PASS input limits preserve source/results and offer replacement without repeating the same analysis',
);

const limitThenComplete = structuredClone(completeDetail);
limitThenComplete.local.failureCode = 'input_limit';
assert.equal(buildAnalysisProgressView(limitThenComplete).inputLimited, false);

// 명시된 코드보다 막연한 worker_failed가 원인을 덮지 않고 알려지지 않은 실패는 추정하지 않습니다.
const memoryFailure = fixtureTask();
const memoryAttempt = memoryFailure.conversions[0];
if (!memoryAttempt) throw new Error('Failure fixture missing');
memoryAttempt.diagnosticCodes = ['worker_failed', 'conversion_memory_failed'];
const memoryView = buildDocumentTaskView(memoryFailure);
assert.match(memoryView.explanation.body, /메모리/);
assert.match(memoryView.explanation.next, /여유 메모리/);
memoryAttempt.diagnosticCodes = ['source_download_failed'];
assert.match(
  buildDocumentTaskView(memoryFailure).explanation.next,
  /서버 연결/,
);
memoryAttempt.diagnosticCodes = ['unknown_future_failure'];
memoryAttempt.reportSummary = null;
assert.match(
  buildDocumentTaskView(memoryFailure).explanation.body,
  /구체적인 중단 원인을 확인하지 못/,
);
assert.equal(conversionFailureExplanation(['unknown_future_failure']), null);
assert.equal(conversionFailureExplanation([]), null);
assert.match(
  conversionFailureExplanation(['conversion_output_limit'])?.next ?? '',
  /반복 변환/,
);
assert.match(
  conversionFailureExplanation(['dependency_missing_tesseract'])?.next ?? '',
  /실행 준비/,
);
assert.match(
  conversionFailureExplanation(['worker_failed'])?.body ?? '',
  /구체적인 중단 원인/,
);
console.log(
  'PASS conversion failure reason and next step follow recorded codes without inventing an unknown cause',
);

assert.match(
  conversionFailureExplanation(['conversion_checkpoint_locked'])?.body ?? '',
  /접근 거부 또는 파일 잠금/,
);
assert.match(
  conversionFailureExplanation(['report_save_unconfirmed', 'worker_failed'])
    ?.body ?? '',
  /실패로 확정할 수 없습니다/,
);
assert.match(
  conversionFailureExplanation(['conversion_start_failed'])?.body ?? '',
  /시작하지 못/,
);
