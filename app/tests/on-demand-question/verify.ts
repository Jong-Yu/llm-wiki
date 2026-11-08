import assert from 'node:assert/strict';
import { parseWorkspaceRequest } from '@contracts/workspace.contract';
import { projectQuestion } from '@main/backend/questionRunProjection';
import {
  citationFacts,
  citationKind,
} from '@renderer/features/chat-with-knowledge/model/chatCitations';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { QuestionSession } from '@contracts/questionRuns.contract';

const id = '1'.repeat(32);
const revision = 'a'.repeat(64);
const graphRevision = 'b'.repeat(64);
const stateRevision = 'c'.repeat(64);
const session: QuestionSession = {
  connectionId: 'fixture',
  expectedScope: {
    userId: 'tester',
    tenant: 'fixture',
    profileId: 'default',
    policyRevision: revision,
  },
};
const request = {
  ...session,
  operation: 'questionContext',
  input: { documents: ['guide.md'], required_documents: ['guide.md'] },
};
assert.deepEqual(parseWorkspaceRequest(request), request);
assert.deepEqual(
  parseWorkspaceRequest({
    ...request,
    input: { ...request.input, mode: 'on_demand' },
  }),
  { ...request, input: { ...request.input, mode: 'on_demand' } },
);
assert.throws(() =>
  parseWorkspaceRequest({
    ...request,
    input: { ...request.input, mode: 'automatic' },
  }),
);
const indexedRequest = {
  ...request,
  input: {
    ...request.input,
    mode: 'on_demand',
    retrieval_scope: 'workspace',
    lookup_question: '펌프의 정비 예외는?',
  },
};
assert.deepEqual(parseWorkspaceRequest(indexedRequest), indexedRequest);
assert.throws(() =>
  parseWorkspaceRequest({
    ...indexedRequest,
    input: { ...indexedRequest.input, retrieval_scope: 'unrestricted' },
  }),
);

/** 기존 전체 근거와 새 불변 참조가 같은 근거 판본으로 표시되는지 대조합니다. */
function serverQuestion(basis: unknown): unknown {
  return {
    record: {
      id,
      kind: 'question-runs',
      tenant: 'fixture',
      user_id: 'tester',
      actor: { profile_id: 'default' },
      data: {
        conversation_id: '2'.repeat(32),
        question_turn_id: '3'.repeat(32),
        question: '펌프의 정비 요건은?',
        basis,
      },
    },
    state_revision: revision,
    runtime: { status: 'queued', progress: 'prepared' },
    lease_status: 'none',
    answer_requests: [],
    human_approval: false,
    server_ai_executed: false,
  };
}
const fullBasis = {
  kind: 'question_context',
  snapshot_revision: revision,
  documents: [
    {
      document: 'guide.md',
      source_revision: revision,
      content: '# 정비 요건',
      knowledge: {
        graph_revision: graphRevision,
        state_revision: stateRevision,
      },
    },
  ],
};
const referencedBasis = {
  kind: 'question_basis_ref_v1',
  basis_id: revision,
  snapshot_revision: revision,
  documents: [
    {
      id: 'd1',
      document: 'guide.md',
      source_revision: revision,
      graph_revision: graphRevision,
      state_revision: stateRevision,
      title: '정비 요건',
      line_count: 1,
    },
  ],
};
const full = projectQuestion(serverQuestion(fullBasis), session, id);
const referenced = projectQuestion(
  serverQuestion(referencedBasis),
  session,
  id,
);
assert.deepEqual(referenced.evidence, full.evidence);
assert.equal(referenced.basisRevision, full.basisRevision);
assert.equal(referenced.question, full.question);
assert.equal(referenced.evidence[0]?.stateRevision, stateRevision);

// 참조 종류를 선언한 응답은 basis_id 누락이나 잘못된 판본을 legacy로 우회하지 못합니다.
assert.throws(() =>
  projectQuestion(
    serverQuestion({ ...fullBasis, kind: 'question_basis_ref_v1' }),
    session,
    id,
  ),
);
assert.throws(() =>
  projectQuestion(
    serverQuestion({
      ...referencedBasis,
      documents: [{ ...referencedBasis.documents[0], state_revision: 'bad' }],
    }),
    session,
    id,
  ),
);
assert.throws(() =>
  projectQuestion(serverQuestion(referencedBasis), {
    ...session,
    expectedScope: { ...session.expectedScope, userId: 'other-user' },
  }),
);
assert.equal(citationKind({ kind: 'review' }), '검토 이력');
assert.equal(citationKind({ kind: 'policy' }), '전문가 판단 · Action log');
assert.equal(citationKind({ kind: 'claim' }), '온톨로지 주장');
assert.equal(citationKind({ kind: 'document' }), '문서 인용');
// 서버가 보관한 판단 의미는 읽기용으로 유지하고 원장·판본 참조는 표시하지 않습니다.
const policyCitation: KnowledgeValue = {
  kind: 'policy',
  document: 'guide.md',
  event_id: id,
  state_revision: stateRevision,
  layer: 'expert_policy',
  reason: '야외 설치에만 이 판단을 적용합니다.',
  policy_status: 'active',
  policy_scope: { domain: '설비', viewpoint: '안전 담당자' },
};
const reviewCitation: KnowledgeValue = {
  kind: 'review',
  document: 'guide.md',
  event_id: id,
  state_revision: stateRevision,
  ledger: 'relation',
  layer: 'review_history',
  action: 'defer',
  reason: '최소 온도 조건을 확인한 뒤 검토합니다.',
  actor: { user_id: id, tenant: 'fixture', display_name: '검토 담당자' },
  human_approval: false,
};
const retainedPolicy = JSON.stringify(policyCitation);
const retainedReview = JSON.stringify(reviewCitation);
assert.deepEqual(citationFacts(policyCitation), [
  { label: '판단 이유', text: '야외 설치에만 이 판단을 적용합니다.' },
  { label: '인용 당시 판단 상태', text: '적용 중' },
  { label: '업무 영역', text: '설비' },
  { label: '관점', text: '안전 담당자' },
]);
assert.deepEqual(citationFacts(reviewCitation), [
  { label: '검토 내용', text: '보류' },
  { label: '판단 이유', text: '최소 온도 조건을 확인한 뒤 검토합니다.' },
  { label: '작성자', text: '검토 담당자' },
]);
for (const citation of [policyCitation, reviewCitation]) {
  const shown = JSON.stringify(citationFacts(citation));
  for (const internal of [id, stateRevision, 'event_id', 'user_id', 'ledger'])
    assert.equal(shown.includes(internal), false);
}
assert.equal(JSON.stringify(policyCitation), retainedPolicy);
assert.equal(JSON.stringify(reviewCitation), retainedReview);
assert.deepEqual(citationFacts({ kind: 'review' }), []);
assert.deepEqual(citationFacts({ kind: 'policy', policy_scope: {} }), []);
assert.deepEqual(
  citationFacts({
    kind: 'policy',
    policy_scope: { domain: null, viewpoint: null },
  }),
  [
    { label: '업무 영역', text: '전체 영역' },
    { label: '관점', text: '전체 관점' },
  ],
);
assert.deepEqual(citationFacts({ kind: 'claim', review_decision: 'reject' }), [
  { label: '인용 당시 원문 검토', text: '거절' },
]);
assert.match(
  citationFacts({ kind: 'source', layer: 'reported_conversion' })[0]?.text ||
    '',
  /원본 전체의 포함 여부와 의미 정확도는 검증되지 않았습니다/,
);
console.log(
  'PASS 요청 mode 호환·compact/legacy 판본 대응·손상/다른 주체 거부·판단 의미 보존·내부 참조 미노출',
);
