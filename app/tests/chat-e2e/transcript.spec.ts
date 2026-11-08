import { expect, test } from '@playwright/test';
import { buildChatTranscript } from '../../src/renderer/features/chat-with-knowledge/model/chatTranscript';
import type { ChatMessage } from '../../src/renderer/features/chat-with-knowledge/model/chatTranscript';
import { composeQuestion } from '../../src/renderer/features/chat-with-knowledge/model/externalMaterial';
import { templateById } from '../../src/renderer/features/chat-with-knowledge/model/answerTemplates';
import type { ChatTurn } from '../../src/renderer/features/chat-with-knowledge/model/chatState';

test('답변은 명시한 질문을 우선하며 없는 질문을 다른 질문으로 추정하지 않는다', (): void => {
  const turns: ChatTurn[] = [
    { id: 'q1', role: 'user', content: '첫 질문' },
    { id: 'q2', role: 'user', content: '두 번째 질문' },
    { id: 'a1', role: 'assistant', content: '이전 질문 답변', reply_to: 'q1' },
    { id: 'a2', role: 'assistant', content: '예전 버전 답변' },
    {
      id: 'a3',
      role: 'assistant',
      content: '없는 질문 답변',
      reply_to: 'missing',
    },
  ];
  const answers = buildChatTranscript(turns, []).filter(
    (message: ChatMessage): boolean => message.kind === 'answer',
  );
  expect(
    answers.map(
      (message: ChatMessage): string | null =>
        message.question?.question ?? null,
    ),
  ).toEqual(['첫 질문', '두 번째 질문', null]);
});

test('실행에서 확인한 빈 인용도 보존하고 과거 대화 인용은 실행 정보가 없을 때 사용한다', (): void => {
  const transcript = buildChatTranscript(
    [
      {
        id: 'a1',
        role: 'assistant',
        content: '답변',
        citations: [{ old: true }],
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '예전 답변',
        citations: [{ old: true }],
      },
    ],
    [{ turnId: 'a1', content: '답변', citations: [] }],
  );
  expect(
    transcript.map((message: ChatMessage): unknown => message.citations),
  ).toEqual([[], [{ old: true }]]);
});

test('같은 질문의 재시도 답변도 질문 본문·첨부·양식·근거 없음 표시를 함께 사용한다', (): void => {
  const template = templateById('compare-report');
  const content = composeQuestion(
    '두 문서를 비교해 줘',
    [
      {
        id: 'file',
        kind: 'file',
        name: '자료.txt',
        text: '비교할 자료',
        truncated: false,
      },
    ],
    template,
    true,
  );
  const transcript = buildChatTranscript(
    [
      { id: 'q1', role: 'user', content },
      { id: 'a1', role: 'assistant', content: '첫 답변', reply_to: 'q1' },
      { id: 'a2', role: 'assistant', content: '재시도 답변', reply_to: 'q1' },
    ],
    [],
  );
  for (const message of transcript) {
    expect(message.question).toMatchObject({
      question: '두 문서를 비교해 줘',
      noEvidence: true,
      template: { id: 'compare-report' },
      attachments: [{ name: '자료.txt', text: '비교할 자료' }],
    });
  }
});

test('빈 대화와 앞선 질문이 없는 과거 답변을 그대로 표시한다', (): void => {
  expect(buildChatTranscript([], [])).toEqual([]);
  expect(
    buildChatTranscript(
      [{ id: 'a1', role: 'assistant', content: '과거 답변' }],
      [],
    ),
  ).toEqual([
    {
      kind: 'answer',
      turn: { id: 'a1', role: 'assistant', content: '과거 답변' },
      question: null,
      questionTurnId: null,
      citations: [],
    },
  ]);
});
