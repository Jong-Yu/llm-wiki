import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
async function load(file) {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@contracts': resolve(root, 'src/shared/contracts') } },
    ssr: { noExternal: true },
    build: {
      write: false,
      ssr: fileURLToPath(new URL(file, import.meta.url)),
      rolldownOptions: { output: { format: 'es' } },
    },
  });
  const chunk = (Array.isArray(built) ? built[0].output : built.output).find(
    (item) => item.type === 'chunk' && item.isEntry,
  );
  assert.ok(chunk);
  return await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  );
}
const {
  chatRunFailure,
  chatRunProgress,
  chatRunCommentaries,
  rememberChatRunNotice,
  canAdvanceChatDraft,
} = await load('./chatRunFeedback.ts');
const { applyQuestionCliEvent, idleQuestionLocal } = await load(
  '../../../../main/backend/questionRunProjection.ts',
);
const { chatRecoverySchema, emptyChat } = await load('./chatState.ts');
const { visibleSubmittedQuestion } = await load('./chatTranscript.ts');
const conversationId = 'c'.repeat(32);
const questionId = 'a'.repeat(32);
const answerId = 'b'.repeat(32);
const runId = 'd'.repeat(32);
const beforeRevision = '1'.repeat(64);
const afterRevision = '2'.repeat(64);
const question = { id: questionId, role: 'user', content: '질문' };
const answer = {
  id: answerId,
  role: 'assistant',
  content: '답변',
  reply_to: questionId,
};

await test('생존 확인과 다른 실행의 이벤트는 마지막 실제 진행 단계를 덮어쓰지 않는다', () => {
  const event = (phase, id = runId) => ({
    protocol: 'question-cli-v1',
    type: 'phase',
    question_run_id: id,
    phase,
    saved: false,
  });
  const reading = applyQuestionCliEvent(
    idleQuestionLocal(),
    event('evidence_read'),
    runId,
  );
  assert.equal(reading.phase, 'evidence_read');
  assert.equal(
    applyQuestionCliEvent(reading, event('heartbeat'), runId),
    reading,
  );
  assert.equal(
    applyQuestionCliEvent(reading, event('submitting', 'f'.repeat(32)), runId),
    reading,
  );
  const saving = applyQuestionCliEvent(reading, event('submitting'), runId);
  assert.equal(saving.phase, 'submitting');
  assert.equal(
    applyQuestionCliEvent(saving, event('heartbeat'), runId),
    saving,
  );
});

await test('AI 설명 전에는 단계 라벨 대신 대기만 표시하고 중단 요청은 알린다', () => {
  const detail = run({
    status: 'running',
    progress: 'answering',
    local: {
      ...idleQuestionLocal(),
      status: 'running',
      phase: 'raw /private/path or model text',
    },
  });
  assert.equal(chatRunProgress(detail), '답변을 준비하고 있어요');
  detail.local.phase = '';
  detail.progress = 'submitting';
  assert.equal(chatRunProgress(detail), '답변을 준비하고 있어요');
  detail.local.status = 'stopping';
  assert.equal(chatRunProgress(detail), '답변 생성을 멈추고 있어요');
});

function commentaryEvent(messageId, content, patch = {}) {
  return {
    protocol: 'question-cli-v1',
    type: 'commentary',
    question_run_id: runId,
    run_id: '3'.repeat(32),
    message_id: messageId,
    content,
    saved: false,
    origin: 'client_reported',
    ...patch,
  };
}

await test('AI 작업 설명은 메시지 ID별로 갱신하고 같은 이벤트를 중복하지 않는다', () => {
  const first = applyQuestionCliEvent(
    idleQuestionLocal(),
    commentaryEvent('read', '센서의 경고 조건을 읽겠습니다.'),
    runId,
  );
  assert.deepEqual(first.commentaries, [
    { id: 'read', content: '센서의 경고 조건을 읽겠습니다.' },
  ]);
  assert.equal(
    applyQuestionCliEvent(
      first,
      commentaryEvent('read', first.commentaries[0].content),
      runId,
    ),
    first,
  );
  const second = applyQuestionCliEvent(
    first,
    commentaryEvent('compare', '운전 모드별 예외도 비교하겠습니다.'),
    runId,
  );
  const updated = applyQuestionCliEvent(
    second,
    commentaryEvent('read', '센서의 경고 조건을 확인했습니다.'),
    runId,
  );
  assert.deepEqual(updated.commentaries, [
    { id: 'read', content: '센서의 경고 조건을 확인했습니다.' },
    { id: 'compare', content: '운전 모드별 예외도 비교하겠습니다.' },
  ]);
  assert.equal(updated.preview, '');
  assert.equal(updated.phase, '');
});

await test('다른 실행·미확인 출처·잘못된 내용의 작업 설명은 표시하지 않는다', () => {
  const local = idleQuestionLocal();
  for (const patch of [
    { question_run_id: 'f'.repeat(32) },
    { question_run_id: undefined },
    { saved: true },
    { saved: null },
    { saved: undefined },
    { origin: 'server' },
    { origin: undefined },
    { message_id: '' },
    { message_id: '  ' },
    { message_id: 'x'.repeat(101) },
    { content: '' },
    { content: '\n  ' },
    { content: 'x'.repeat(2001) },
    { type: 'reasoning' },
  ])
    assert.equal(
      applyQuestionCliEvent(
        local,
        commentaryEvent('note', '공개 설명', patch),
        runId,
      ),
      local,
    );
});

await test('설명은 최근 20개까지만 남기고 새 실행의 로컬 상태에는 남지 않는다', () => {
  let local = idleQuestionLocal();
  for (let i = 0; i < 22; i += 1)
    local = applyQuestionCliEvent(
      local,
      commentaryEvent(`note-${i}`, `설명 ${i}`),
      runId,
    );
  assert.equal(local.commentaries.length, 20);
  assert.equal(local.commentaries[0].id, 'note-2');
  assert.equal(local.commentaries.at(-1).id, 'note-21');
  assert.deepEqual(idleQuestionLocal().commentaries, []);
});

await test('진행 중 설명은 확정 답변·영수증·종료·다음 질문에서 숨긴다', () => {
  const comments = [
    { id: 'read', content: '문서의 경고 조건을 비교하고 있습니다.' },
  ];
  const detail = run({
    status: 'running',
    leaseStatus: 'active',
    answers: [],
    receipts: [],
    local: {
      ...idleQuestionLocal(),
      status: 'running',
      commentaries: comments,
    },
  });
  assert.deepEqual(chatRunCommentaries(detail, false), comments);
  assert.deepEqual(chatRunCommentaries(detail, true), []);
  assert.deepEqual(
    chatRunCommentaries(
      {
        ...detail,
        answers: [{ turnId: answerId, content: '정리된 답변', citations: [] }],
      },
      false,
    ),
    [],
  );
  assert.deepEqual(
    chatRunCommentaries({ ...detail, receipts: [{ saved: true }] }, false),
    [],
  );
  assert.deepEqual(
    chatRunCommentaries({ ...detail, receipts: [{ saved: null }] }, false),
    comments,
  );
  assert.deepEqual(
    chatRunCommentaries(
      {
        ...detail,
        status: 'failed',
        leaseStatus: 'none',
        local: { ...detail.local, status: 'failed' },
      },
      false,
    ),
    [],
  );
  assert.deepEqual(
    chatRunCommentaries(
      {
        ...detail,
        status: 'cancelled',
        leaseStatus: 'none',
        local: { ...detail.local, status: 'exited' },
      },
      false,
    ),
    [],
  );
  assert.deepEqual(
    chatRunCommentaries(
      { ...detail, local: { ...detail.local, commentaries: undefined } },
      false,
    ),
    [],
  );
});
function envelope(events, revision = beforeRevision) {
  return {
    revision,
    record: {
      id: conversationId,
      kind: 'conversations',
      tenant: 'test',
      user_id: 'tester',
      data: { title: '대화' },
      events,
      requests: {},
    },
  };
}
function run(patch = {}) {
  return {
    id: runId,
    conversationId,
    questionTurnId: questionId,
    status: 'complete',
    leaseStatus: 'none',
    answers: [{ turnId: answerId, content: '답변', citations: [] }],
    receipts: [
      {
        request_id: 'e'.repeat(32),
        saved: true,
        receipt: {
          question_run_id: runId,
          conversation_id: conversationId,
          conversation_revision: afterRevision,
          answer_turn_id: answerId,
        },
      },
    ],
    local: { status: 'exited', requestId: null, errorCode: null },
    ...patch,
  };
}

await test('자기 실행의 저장 영수증으로 확인한 답변만 추가되면 초안 기준을 이동한다', () => {
  assert.equal(
    canAdvanceChatDraft(
      envelope([question]),
      envelope([question, answer], afterRevision),
      run(),
      beforeRevision,
    ),
    true,
  );
});
await test('외부 질문·수정·다른 답변은 초안 기준을 자동 교체하지 않는다', () => {
  const before = envelope([question]);
  for (const events of [
    [
      question,
      { id: 'f'.repeat(32), role: 'user', content: '다른 질문' },
      answer,
    ],
    [{ ...question, content: '바뀐 질문' }, answer],
    [question, { ...answer, reply_to: 'f'.repeat(32) }],
    [question, { ...answer, content: '다른 답변' }],
  ])
    assert.equal(
      canAdvanceChatDraft(
        before,
        envelope(events, afterRevision),
        run(),
        beforeRevision,
      ),
      false,
    );
});
await test('영수증 미확인·다른 실행·다른 판본·오래된 초안은 기존 CAS 기준을 유지한다', () => {
  const before = envelope([question]);
  const after = envelope([question, answer], afterRevision);
  assert.equal(
    canAdvanceChatDraft(before, after, run({ receipts: [] }), beforeRevision),
    false,
  );
  assert.equal(
    canAdvanceChatDraft(
      before,
      after,
      run({ id: 'f'.repeat(32) }),
      beforeRevision,
    ),
    false,
  );
  assert.equal(
    canAdvanceChatDraft(before, after, run(), '3'.repeat(64)),
    false,
  );
  assert.equal(
    canAdvanceChatDraft(
      before,
      { ...after, revision: '3'.repeat(64) },
      run(),
      beforeRevision,
    ),
    false,
  );
  assert.equal(
    canAdvanceChatDraft(
      before,
      { ...after, record: { ...after.record, data: { title: '외부 변경' } } },
      run(),
      beforeRevision,
    ),
    false,
  );
});
await test('실패·중단 상태는 질문과 실행에 연결하고 이후 기록을 덮거나 지우지 않는다', () => {
  const first = rememberChatRunNotice(
    [],
    run({
      status: 'failed',
      receipts: [],
      answers: [],
      local: {
        status: 'failed',
        requestId: null,
        errorCode: 'ai_unexpected_tool_activity',
      },
    }),
  );
  const second = rememberChatRunNotice(
    first,
    run({ id: 'f'.repeat(32), status: 'cancelled', receipts: [], answers: [] }),
  );
  assert.deepEqual(first, [
    {
      runId,
      questionTurnId: questionId,
      status: 'failed',
      errorCode: 'ai_unexpected_tool_activity',
    },
  ]);
  assert.equal(second.length, 2);
  assert.equal(second[1].status, 'cancelled');
  assert.equal(rememberChatRunNotice(second, run()).length, 2);
  const restored = rememberChatRunNotice(
    first,
    run({
      status: 'failed',
      receipts: [],
      answers: [],
      local: { status: 'idle', requestId: null, errorCode: null },
    }),
  );
  assert.deepEqual(restored, first);
  assert.equal(
    rememberChatRunNotice(
      second,
      run({
        id: 'f'.repeat(32),
        status: 'cancelled',
        receipts: [],
        answers: [],
      }),
    ).length,
    2,
  );
});
await test('실행 중과 저장 미확인을 실패·중단 완료로 기록하지 않는다', () => {
  assert.deepEqual(
    rememberChatRunNotice(
      [],
      run({
        status: 'cancelled',
        local: { status: 'stopping', requestId: null, errorCode: null },
      }),
    ),
    [],
  );
  assert.deepEqual(
    rememberChatRunNotice(
      [],
      run({ status: 'failed', receipts: [{ saved: null }] }),
    ),
    [],
  );
  assert.deepEqual(
    rememberChatRunNotice(
      [],
      run({
        status: 'failed',
        receipts: [],
        local: { status: 'failed', requestId: 'x', errorCode: null },
      }),
    ),
    [],
  );
});
await test('오류 안내는 도구·형식·미완료·연결을 구분하고 원시 오류를 보관하지 않는다', () => {
  assert.match(chatRunFailure('ai_unexpected_tool_activity').title, /도구/);
  assert.equal(chatRunFailure('ai_unexpected_tool_activity').connection, false);
  assert.match(
    chatRunFailure('ai_cli_event_rejected').title,
    /허용되지 않은 동작/,
  );
  assert.equal(chatRunFailure('ai_cli_event_rejected').connection, false);
  assert.match(chatRunFailure('ai_invalid_result').title, /결과/);
  assert.match(chatRunFailure('ai_incomplete_turn').title, /끝나기 전/);
  assert.equal(chatRunFailure('ai_cli_unavailable').connection, true);
  assert.equal(chatRunFailure('ai_execution_failed').connection, false);
  assert.equal(chatRunFailure('unknown').connection, false);
  // 실행 준비 실패는 로그인·CLI 위치 문제로 안내하지 않는다. 기존 의존성 안내는 유지한다.
  for (const code of ['ai_process_job_failed', 'ai_windows_file_unavailable']) {
    assert.match(chatRunFailure(code).title, /실행을 준비하지 못했어요/);
    assert.equal(chatRunFailure(code).connection, false);
  }
  assert.equal(
    chatRunFailure('ai_windows_dependency_missing').connection,
    true,
  );
  assert.match(chatRunFailure('unknown').title, /답변 처리 중 오류/);
  const notices = rememberChatRunNotice(
    [],
    run({
      status: 'failed',
      receipts: [],
      local: {
        status: 'failed',
        requestId: null,
        errorCode: 'raw log with /private/path',
      },
    }),
  );
  assert.equal(notices[0].errorCode, null);
});
await test('이전 보호 복구 자료를 기본 빈 실행 이력으로 읽고 새 이력을 보존한다', () => {
  const thread = emptyChat();
  delete thread.runNotices;
  const old = chatRecoverySchema.parse({
    activeId: thread.id,
    threads: [thread],
    pending: null,
  });
  assert.deepEqual(old.threads[0].runNotices, []);
  old.threads[0].runNotices = [
    {
      runId,
      questionTurnId: questionId,
      status: 'failed',
      errorCode: 'ai_invalid_result',
    },
  ];
  const saved = chatRecoverySchema.parse(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(saved.threads[0].runNotices, old.threads[0].runNotices);
});
await test('저장 전 질문은 즉시 표시하고, 복구하거나 저장 응답을 잃어도 중복 표시하지 않는다', () => {
  const threadId = '1'.repeat(32);
  const submitted = { id: questionId, content: '전송한 질문', threadId };
  const pending = {
    step: 'question',
    requestId: questionId,
    recordId: conversationId,
    sentQuestion: '전송한 질문',
    threadId,
  };
  assert.deepEqual(
    visibleSubmittedQuestion(submitted, null, threadId, []),
    submitted,
  );
  assert.deepEqual(visibleSubmittedQuestion(null, pending, threadId, []), {
    id: questionId,
    content: '전송한 질문',
  });
  assert.equal(
    visibleSubmittedQuestion(submitted, pending, threadId, [question]),
    null,
  );
  assert.equal(
    visibleSubmittedQuestion(null, pending, '2'.repeat(32), []),
    null,
  );
  assert.equal(
    visibleSubmittedQuestion(
      null,
      { ...pending, step: 'conversation' },
      threadId,
      [],
    ),
    null,
  );
});
