import assert from 'node:assert/strict';
import {
  readSessionPage,
  readSessionScope,
  questionStatus,
  SessionScopeError,
} from '../../src/renderer/features/browse-ai-sessions/api/aiSessions.api';
import { mergeSessionPages } from '../../src/renderer/features/browse-ai-sessions/model/useSessionCatalog';
import {
  readSourceAnalysisIndex,
  sourceAnalysisKey,
  sourceAnalysisKind,
} from '../../src/renderer/features/browse-document-library/api/sourceAnalysis.api';
import {
  dismissFinished,
  finishedScopeKey,
  readFinished,
  recordFinished,
  restoreFinished,
} from '../../src/renderer/features/browse-ai-sessions/model/finishedActivities';
import type { AnalysisJob } from '@contracts/analysis.contract';
import type {
  QuestionDetail,
  QuestionError,
  QuestionReceipt,
} from '@contracts/questionRuns.contract';
import {
  workspacePageKey,
  workspaceParentLocation,
} from '../../src/renderer/app/workspaceNavigation';

const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
let allowed = true;
let changed = false;
let drift = false;
let rejectAnalysis = false;
let rejectQuestion = false;
let unreadableQuestion = false;
let questionCalls = 0;
let analysisCursor: string | null = null;
let analysisError: QuestionError | null = null;
let questionError: QuestionError | null = null;
let detailError: QuestionError | null = null;
let skippedCount = 0;
let analysisTruncated = false;
let requiresRefresh = false;
let questionCursor: string | null = null;
let questionIncomplete = false;
const id = 'a'.repeat(32);
const version = 'b'.repeat(32);
const conversation = 'c'.repeat(32);
const question = 'd'.repeat(32);
const revision = 'e'.repeat(64);
const detail: QuestionDetail = {
  id: question,
  conversationId: conversation,
  questionTurnId: id,
  question: '검증 질문',
  profileId: 'default',
  basisRevision: revision,
  evidence: [],
  stateRevision: revision,
  status: 'complete',
  progress: '',
  leaseStatus: 'none',
  receipts: [],
  answers: [],
  answerReadError: null,
  local: {
    status: 'idle',
    phase: '',
    preview: '',
    requestId: null,
    errorCode: null,
    cleanupWarning: false,
  },
};
const scope = {
  userId: 'tester',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: revision,
};
const storage = new Map<string, string>();
const mock = {
  localStorage: {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
  },
  dispatchEvent: (): boolean => true,
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
  wiki: {
    connection: {
      getState: async (): Promise<unknown> => ({
        ok: true,
        data: {
          status: 'connected',
          connectionId: 'fixture-connection',
          ...scope,
          userId: changed ? 'another-user' : scope.userId,
          selection: { tenant: scope.tenant, profile: scope.profileId },
          workspaces: [
            { id: scope.tenant, permissions: allowed ? ['read'] : [] },
          ],
        },
      }),
    },
    analysis: {
      list: async (request: { cursor: string | null }): Promise<unknown> => {
        analysisCursor = request.cursor;
        if (drift) changed = true;
        if (analysisError) return { ok: false, error: analysisError };
        if (rejectAnalysis)
          return { ok: false, error: { message: '분석 읽기 실패' } };
        return {
          ok: true,
          data: {
            items: [
              {
                job_id: id,
                registration: null,
                source_ref: { source_id: id, source_version: version },
                targets: [{ document: 'fixture.md' }],
                result_summary: { status: 'pending_reconcile' },
                state: 'claimed',
                reported_status: null,
                lease_status: 'expired',
              },
            ],
            nextCursor: request.cursor ? null : 'next-analysis',
            complete: !!request.cursor,
            truncated: analysisTruncated,
            skippedCount,
            requiresRefresh,
          },
        };
      },
    },
    questionRuns: {
      list: async (): Promise<unknown> => {
        questionCalls++;
        if (questionError) return { ok: false, error: questionError };
        return rejectQuestion
          ? { ok: false, error: { message: '질문 읽기 실패' } }
          : {
              ok: true,
              data: {
                items: [
                  {
                    id: question,
                    title: '검증 질문',
                    created_at: '2026-10-29',
                  },
                ],
                nextCursor: questionCursor,
                incomplete: questionIncomplete,
              },
            };
      },
      read: async (): Promise<unknown> =>
        detailError
          ? { ok: false, error: detailError }
          : unreadableQuestion
            ? { ok: false, error: { message: '대상 접근 불가' } }
            : {
                ok: true,
                data: detail,
              },
    },
    knowledgeComparisons: {
      list: async (): Promise<unknown> => ({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false },
      }),
    },
  },
};
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: mock,
});
try {
  const session = await readSessionScope();
  const all = { sourceId: null, sourceVersion: null, document: null };
  const first = await readSessionPage(session, all, null);
  assert.equal(first.items[0]?.href, `/jobs?jobId=${id}`);
  assert.equal(first.items[0]?.status, '저장 결과 확인 필요');
  assert.equal(
    first.items[1]?.href,
    `/chat?conversationId=${conversation}&questionRunId=${question}`,
  );
  assert.equal(first.incomplete, true);
  console.log(
    'PASS session targets preserve job/conversation/run identity and unknown save state',
  );

  const previousQuestions = questionCalls;
  const filtered = await readSessionPage(
    session,
    { sourceId: id, sourceVersion: 'f'.repeat(32), document: null },
    null,
  );
  assert.equal(filtered.items.length, 0);
  assert.equal(questionCalls, previousQuestions);
  assert.equal(filtered.cursors.analysis, 'next-analysis');
  console.log(
    'PASS source version filter never substitutes the current version and retains pagination',
  );

  const selected = await readSessionPage(
    session,
    { ...all, document: 'fixture.md' },
    { analysis: 'next-analysis', question: null },
  );
  assert.equal(analysisCursor, 'next-analysis');
  assert.equal(questionCalls, previousQuestions);
  assert.equal(selected.items.length, 1);
  assert.equal(selected.incomplete, false);
  console.log(
    'PASS next page only reads outstanding streams and keeps exact document target',
  );

  const complete = mergeSessionPages(first, selected);
  assert.equal(first.hasGaps, false);
  assert.equal(complete.items.length, 2);
  assert.equal(complete.incomplete, false);
  questionCursor = 'next-question';
  const questionFirst = await readSessionPage(session, all, {
    analysis: null,
    question: 'start-question',
  });
  assert.equal(questionFirst.hasGaps, false);
  assert.equal(questionFirst.incomplete, true);
  questionCursor = null;
  const questionFinal = await readSessionPage(
    session,
    all,
    questionFirst.cursors,
  );
  assert.equal(
    mergeSessionPages(questionFirst, questionFinal).incomplete,
    false,
  );
  skippedCount = 1;
  const skipped = await readSessionPage(session, all, null);
  skippedCount = 0;
  assert.equal(mergeSessionPages(skipped, selected).incomplete, true);
  analysisTruncated = true;
  const truncated = await readSessionPage(session, all, null);
  analysisTruncated = false;
  assert.equal(mergeSessionPages(truncated, selected).incomplete, true);
  requiresRefresh = true;
  const refresh = await readSessionPage(session, all, null);
  requiresRefresh = false;
  assert.equal(refresh.cursors.analysis, null);
  assert.equal(refresh.hasGaps, true);
  assert.ok(
    refresh.messages.some((message: string): boolean =>
      message.includes('새로고침'),
    ),
  );
  questionIncomplete = true;
  const questionGap = await readSessionPage(session, all, {
    analysis: null,
    question: 'start-question',
  });
  questionIncomplete = false;
  assert.equal(mergeSessionPages(questionGap, questionFinal).incomplete, true);
  console.log(
    'PASS final cursor completes pagination while skipped records remain incomplete',
  );

  const receipt: QuestionReceipt = {
    record_id: id,
    request_id: id,
    state: 'complete',
    saved: null,
    receipt: null,
    cleanup_failures: [],
  };
  assert.equal(
    questionStatus({ ...detail, receipts: [receipt] }),
    '저장 결과 확인 필요',
  );
  assert.equal(
    questionStatus({ ...detail, local: { ...detail.local, requestId: id } }),
    '저장 결과 확인 필요',
  );
  assert.equal(
    questionStatus({
      ...detail,
      receipts: [{ ...receipt, saved: false }],
      local: { ...detail.local, requestId: id },
    }),
    '완료',
  );
  assert.equal(
    questionStatus({
      ...detail,
      receipts: [{ ...receipt, state: 'pending_reconcile' }],
    }),
    '저장 결과 확인 필요',
  );
  assert.equal(
    questionStatus({ ...detail, status: 'running', leaseStatus: 'expired' }),
    '진행 확인 필요',
  );
  assert.equal(
    questionStatus({ ...detail, status: 'running', leaseStatus: 'active' }),
    '실행 중',
  );
  assert.equal(
    questionStatus({
      ...detail,
      status: 'queued',
      local: { ...detail.local, status: 'running' },
    }),
    '실행 중',
  );
  assert.equal(
    questionStatus({
      ...detail,
      local: { ...detail.local, status: 'stopping' },
    }),
    '중단 중',
  );
  console.log(
    'PASS unknown receipts, unresolved local writes, expired leases, and local activity match chat semantics',
  );

  unreadableQuestion = true;
  const missing = await readSessionPage(session, all, null);
  assert.equal(missing.items[1]?.href, null);
  assert.equal(missing.items[1]?.status, '대상 확인 불가');
  unreadableQuestion = false;
  console.log(
    'PASS unreadable session remains visible without a fabricated destination',
  );

  rejectQuestion = true;
  const partial = await readSessionPage(session, all, null);
  assert.equal(partial.items.length, 1);
  assert.equal(partial.incomplete, true);
  assert.ok(partial.messages.includes('질문 읽기 실패'));
  rejectAnalysis = true;
  const failed = await readSessionPage(session, all, null);
  assert.equal(failed.items.length, 0);
  assert.equal(failed.incomplete, true);
  assert.equal(failed.messages.length, 2);
  rejectAnalysis = false;
  rejectQuestion = false;
  console.log(
    'PASS stream failures are incomplete results rather than a false empty success',
  );

  for (const error of [
    { code: 'forbidden', message: '접근 거부', status: 403 },
    { code: 'unauthorized', message: '인증 만료', status: 401 },
    { code: 'scope_changed', message: '관점 변경' },
    { code: 'access_changed', message: '접근 변경' },
    { code: 'remote_failure', message: '권한 없음', status: 403 },
  ]) {
    analysisError = error;
    await assert.rejects(
      readSessionPage(session, all, null),
      SessionScopeError,
    );
    analysisError = null;
    questionError = error;
    await assert.rejects(
      readSessionPage(session, all, null),
      SessionScopeError,
    );
    questionError = null;
    detailError = error;
    await assert.rejects(
      readSessionPage(session, all, null),
      SessionScopeError,
    );
    detailError = null;
  }
  console.log(
    'PASS analysis, question-list, and question-detail denials cannot become partial results',
  );
  const originalScopeRead = mock.wiki.connection.getState;
  mock.wiki.connection.getState = async (): Promise<unknown> => {
    throw Object.assign(new Error('인증 만료'), { status: 401 });
  };
  await assert.rejects(readSessionScope(), SessionScopeError);
  mock.wiki.connection.getState = originalScopeRead;
  console.log(
    'PASS rejected connection-state authorization errors invalidate the catalog',
  );

  drift = true;
  await assert.rejects(readSessionPage(session, all, null), SessionScopeError);
  drift = false;
  changed = false;
  console.log('PASS late data is rejected after an authenticated scope change');
  allowed = false;
  await assert.rejects(readSessionScope(), /조회 권한/);
  console.log('PASS missing read permission blocks session discovery');

  // 원본 행 상태는 서버 작업 영수증에서만 정하고 저장 완료만 "분석 완료"로 본다.
  const kindOf = (overrides: Record<string, unknown>): string =>
    sourceAnalysisKind({
      result_summary: { status: 'not_started' },
      state: 'claimed',
      reported_status: null,
      lease_status: 'none',
      ...overrides,
    } as unknown as AnalysisJob);
  assert.equal(kindOf({ result_summary: { status: 'complete' } }), 'complete');
  assert.equal(kindOf({ lease_status: 'active' }), 'running');
  assert.equal(kindOf({ state: 'awaiting_cli' }), 'pending');
  assert.equal(kindOf({ reported_status: 'failed' }), 'attention');
  assert.equal(kindOf({ state: 'cancelled' }), 'attention');
  assert.equal(
    kindOf({ result_summary: { status: 'partial' }, lease_status: 'expired' }),
    'attention',
  );
  const sourceIndex = await readSourceAnalysisIndex('fixture-connection');
  assert.equal(
    sourceIndex.bySource.get(sourceAnalysisKey(id, version))?.kind,
    'attention',
  );
  assert.equal(sourceIndex.bySource.size, 1);
  assert.equal(sourceIndex.complete, true);
  skippedCount = 1;
  assert.equal(
    (await readSourceAnalysisIndex('fixture-connection')).complete,
    false,
  );
  skippedCount = 0;
  console.log(
    'PASS source rows derive analysis state from server job receipts',
  );

  // 앱이 꺼진 사이 끝난 작업은 서버 기록의 마지막 이벤트 시각으로 복원하고 확인한 것은 되살리지 않는다.
  const owner = finishedScopeKey('tester', 'fixture');
  const jobAt = (
    jobId: string,
    stamp: string,
    overrides: Record<string, unknown> = {},
  ): AnalysisJob =>
    ({
      job_id: jobId,
      registration: { title: `작업 ${jobId.slice(0, 1)}` },
      targets: [{ document: `${jobId.slice(0, 1)}.md` }],
      events: [
        { kind: 'created', timestamp: '2026-01-01T00:00:00+00:00' },
        { kind: 'update', timestamp: stamp },
      ],
      result_summary: { status: 'complete' },
      state: 'claimed',
      reported_status: null,
      lease_status: 'none',
      ...overrides,
    }) as unknown as AnalysisJob;
  const doneJob = jobAt('1'.repeat(32), '2026-05-01T00:00:00+00:00');
  const failedJob = jobAt('2'.repeat(32), '2026-05-02T00:00:00+00:00', {
    result_summary: { status: 'not_started' },
    reported_status: 'failed',
  });
  const oldJob = jobAt('3'.repeat(32), '2026-02-01T00:00:00+00:00');
  const runningJob = jobAt('4'.repeat(32), '2026-05-03T00:00:00+00:00', {
    result_summary: { status: 'not_started' },
    lease_status: 'active',
  });
  // 처음 여는 기기는 과거 기록을 쏟아내지 않고 기준 시각만 정한다.
  restoreFinished(
    owner,
    [doneJob, failedJob, oldJob],
    '2026-03-01T00:00:00+00:00',
    true,
  );
  assert.equal(readFinished(owner).length, 0);
  restoreFinished(
    owner,
    [doneJob, failedJob, oldJob, runningJob],
    '2026-06-01T00:00:00+00:00',
    true,
  );
  assert.deepEqual(
    readFinished(owner).map((item) => [item.id[0], item.result]),
    [
      ['2', '실패'],
      ['1', '완료'],
    ],
  );
  // 확인(✕)한 작업은 같은 기록을 다시 읽어도 나타나지 않고, 다른 사용자 기록과 섞이지 않는다.
  dismissFinished(owner, { kind: 'analysis', id: failedJob.job_id });
  restoreFinished(
    owner,
    [doneJob, failedJob],
    '2026-07-01T00:00:00+00:00',
    true,
  );
  assert.deepEqual(
    readFinished(owner).map((item) => item.id[0]),
    ['1'],
  );
  assert.equal(readFinished(finishedScopeKey('other', 'fixture')).length, 0);
  // 조회가 일부뿐이면 기준 시각을 옮기지 않아 놓친 작업을 다음에 다시 찾는다.
  const lateJob = jobAt('5'.repeat(32), '2026-07-15T00:00:00+00:00');
  restoreFinished(owner, [], '2026-08-01T00:00:00+00:00', false);
  restoreFinished(owner, [lateJob], '2026-08-02T00:00:00+00:00', true);
  assert.ok(readFinished(owner).some((item) => item.id[0] === '5'));
  // 다시 돌기 시작한 작업은 확인 기록에서 풀려 새로 끝날 때 다시 알린다.
  recordFinished(
    owner,
    [],
    [{ kind: 'analysis', id: failedJob.job_id } as never],
  );
  restoreFinished(owner, [failedJob], '2026-09-01T00:00:00+00:00', true);
  assert.equal(
    readFinished(owner).some((item) => item.id[0] === '2'),
    false,
    'restore only counts jobs ended after the last open',
  );
  console.log(
    'PASS finished work is restored from server records and stays dismissed',
  );

  assert.notEqual(
    workspacePageKey('/document', '?path=a.md'),
    workspacePageKey('/document', '?path=b.md'),
  );
  assert.equal(
    workspacePageKey('/document', '?path=a.md&mode=edit'),
    workspacePageKey('/document', '?path=a.md&tab=history'),
  );
  assert.equal(
    workspaceParentLocation('/analysis-proposals', '?document=a.md'),
    '/document?path=a.md',
  );
  assert.equal(workspacePageKey('/unknown', ''), 'not-found');
  console.log(
    'PASS page retention separates documents while preserving editor and history state',
  );
} finally {
  if (original) Object.defineProperty(globalThis, 'window', original);
  else Reflect.deleteProperty(globalThis, 'window');
}
