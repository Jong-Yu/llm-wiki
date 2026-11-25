import assert from 'node:assert/strict';
import type { AnalysisJob } from '@contracts/analysis.contract';
import type {
  NotificationContinueRequest,
  NotificationContinueResult,
  NotificationDetailResult,
  NotificationReadRequest,
} from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { continueReviewedRegistration } from '@renderer/features/review-source-notifications/model/continueReviewedRegistration';
import { visualJob } from '../ai-sessions/visualFixtures';

type Detail = Extract<NotificationDetailResult, { ok: true }>['data'];
const revision = 'e'.repeat(64);
const workflowId = '1'.repeat(32);
const scope: SourceConversionScope = {
  connectionId: 'fixture',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: revision,
};
const job: AnalysisJob = {
  ...visualJob().job,
  request_id: 'd'.repeat(32),
  registration: {
    mode: 'preserve',
    title: '검토한 문서',
    conversion_ref: {
      conversion_id: workflowId,
      conversion_revision: revision,
    },
  },
};
const source = job.source_ref;
const actor = {
  user_id: scope.userId,
  tenant: scope.tenant,
  profile_id: scope.profileId,
};
const original: Detail = {
  access: { ...actor, policy_revision: revision },
  corrections: [],
  events: [],
  conversion: null,
  workflow: {
    workflow_id: workflowId,
    revision,
    source_ref: {
      source_id: source.source_id,
      source_version: source.source_version,
      source_sha256: source.source_sha256,
      registration_revision: source.registration_revision,
    },
    conversion_ref: {
      conversion_id: workflowId,
      conversion_revision: revision,
    },
    title: '검토한 문서',
    target_document: job.targets[0]?.document ?? '',
    state: 'failed',
    pages: [{ page: 1, state: 'usable' }],
    approval: {
      request_id: '2'.repeat(32),
      approved_at: '2026-11-25T00:00:00Z',
      actor,
      device_id: '3'.repeat(32),
      device_name: '합성 기기',
    },
    execution: {
      claim_id: '4'.repeat(32),
      device_id: '3'.repeat(32),
      device_name: '합성 기기',
      claimed_at: '2026-11-25T00:00:00Z',
      job_id: job.job_id,
    },
    resume_request_id: job.request_id,
    created_at: '2026-11-25T00:00:00Z',
    updated_at: '2026-11-25T00:00:00Z',
  },
};
let detail = structuredClone(original);
let current = true;
let reads = 0;
let requests: NotificationContinueRequest[] = [];
let failure: NotificationDetailResult | null = null;
let afterRead: (() => void) | null = null;
let throwRead = false;
let throwContinue = false;
let wrongJob = false;
const bridge = {
  read: async (
    _request: NotificationReadRequest,
  ): Promise<NotificationDetailResult> => {
    reads += 1;
    if (throwRead) throw new Error('read transport failure');
    afterRead?.();
    return failure ?? { ok: true, data: detail };
  },
  continue: async (
    request: NotificationContinueRequest,
  ): Promise<NotificationContinueResult> => {
    requests.push(request);
    if (throwContinue) throw new Error('continue response lost');
    return {
      ok: true,
      data: {
        workflow: detail.workflow,
        jobId: wrongJob ? 'f'.repeat(32) : job.job_id,
        started: true,
      },
    };
  },
};
Object.defineProperty(globalThis, 'window', {
  value: { wiki: { notifications: bridge } },
  configurable: true,
});
/** 각 사례는 새 합성 상태로 시작하며 서버나 실제 사용자 실행기를 호출하지 않습니다. */
function reset(): void {
  detail = structuredClone(original);
  current = true;
  reads = 0;
  requests = [];
  failure = null;
  afterRead = null;
  throwRead = false;
  throwContinue = false;
  wrongJob = false;
}
/** 일반 실행으로 우회할 수 없는 명시 실패 결과인지 확인합니다. */
async function blocked(name: string): Promise<void> {
  const result = await continueReviewedRegistration(
    scope,
    job,
    (): boolean => current,
  );
  assert.ok(result && !result.ok, name);
  assert.equal(requests.length, 0, name);
}
reset();
let result = await continueReviewedRegistration(
  scope,
  job,
  (): boolean => current,
);
assert.ok(result?.ok);
assert.equal(reads, 1);
assert.equal(requests.length, 1);
assert.equal(requests[0]?.expectedRevision, revision);
assert.equal(requests[0]?.workflowId, workflowId);
assert.notEqual(requests[0]?.requestId, original.workflow.execution?.claim_id);
assert.equal(requests[0]?.expectedScope.userId, scope.userId);
reset();
current = false;
await blocked('이미 변경된 scope');
assert.equal(reads, 0);
reset();
afterRead = (): void => {
  current = false;
};
await blocked('read 뒤 대상 변경');
reset();
detail.access.profile_id = 'other';
await blocked('read 접근 범위 변경');
reset();
detail.workflow.conversion_ref = {
  conversion_id: workflowId,
  conversion_revision: 'a'.repeat(64),
};
await blocked('변환 판본 변경');
reset();
detail.workflow.source_ref.source_version = 'a'.repeat(32);
await blocked('원본 판본 변경');
reset();
detail.workflow.execution = null;
await blocked('실행 job 연결 없음');
reset();
detail.workflow.target_document = '다른 문서.md';
await blocked('저장 대상 변경');
reset();
detail.workflow.resume_request_id = 'a'.repeat(32);
await blocked('접수 요청 변경');
reset();
detail.workflow.approval = null;
await blocked('내용 확정 없음');
reset();
detail.workflow.blocked_reason = 'report_changed';
await blocked('이전 보고 차단');
reset();
failure = {
  ok: false,
  error: { code: 'forbidden', status: 403, message: 'denied' },
};
await blocked('조회 권한 거부');
reset();
throwRead = true;
await blocked('조회 결과 미확인');
reset();
failure = {
  ok: false,
  error: { code: 'not_found', status: 404, message: 'none' },
};
assert.equal(
  await continueReviewedRegistration(scope, job, (): boolean => current),
  null,
);
reset();
detail.workflow.pages = [];
assert.equal(
  await continueReviewedRegistration(scope, job, (): boolean => current),
  null,
);
reset();
assert.equal(
  await continueReviewedRegistration(
    scope,
    { ...job, registration: null },
    (): boolean => current,
  ),
  null,
);
assert.equal(reads, 0);
reset();
throwContinue = true;
result = await continueReviewedRegistration(scope, job, (): boolean => current);
assert.ok(result && !result.ok);
assert.equal(requests.length, 1);
reset();
wrongJob = true;
result = await continueReviewedRegistration(scope, job, (): boolean => current);
assert.ok(result && !result.ok);
console.log(
  'PASS reviewed registration resume: 18 scope/basis/claim/fallback cases',
);
