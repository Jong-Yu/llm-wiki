import assert from 'node:assert/strict';
import { buildDocumentTaskView } from '@renderer/features/browse-document-tasks/model/buildDocumentTaskView';
import { documentTaskNeedsAttention } from '@renderer/features/browse-document-tasks/model/documentTask.types';
import { fixtureAnalysis, fixtureTask } from './fixtures';

const task = fixtureTask();
const unchanged = JSON.stringify(task);
const failed = buildDocumentTaskView(task);
assert.equal(failed.state, 'failed');
assert.equal(failed.primaryAction?.id, 'retry-conversion');
assert.match(failed.explanation.body, /구체적인 중단 원인/);
assert.equal(failed.progress, '4 / 170쪽 처리 기록');
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
assert.equal(partial.steps[2]?.state, 'complete');
assert.equal(partial.steps[3]?.state, 'failed');
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
