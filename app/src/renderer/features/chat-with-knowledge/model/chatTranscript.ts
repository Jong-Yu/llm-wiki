import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { QuestionAnswer } from '@contracts/questionRuns.contract';
import type { ChatTurn } from './chatState';
import { splitQuestion } from './externalMaterial';
import type { QuestionContent } from './externalMaterial';

export type ChatMessage =
  | {
      kind: 'question';
      turn: ChatTurn;
      question: QuestionContent;
      citations: KnowledgeValue[];
    }
  | {
      kind: 'answer';
      turn: ChatTurn;
      question: QuestionContent | null;
      questionTurnId: string | null;
      citations: KnowledgeValue[];
    };

/** 질문·답변 대응과 인용 우선순위를 한 번 계산해 본문과 근거 패널이 같은 자료를 표시합니다. */
export function buildChatTranscript(
  turns: readonly ChatTurn[],
  answers: readonly QuestionAnswer[],
): ChatMessage[] {
  const questions = new Map<string, ChatTurn>();
  const citations = new Map<string, KnowledgeValue[]>();
  const parsed = new Map<ChatTurn, QuestionContent>();
  for (const turn of turns) {
    if (turn.role === 'user' && !questions.has(turn.id))
      questions.set(turn.id, turn);
  }
  for (const answer of answers) {
    if (!citations.has(answer.turnId))
      citations.set(answer.turnId, answer.citations);
  }
  /** 같은 질문에 답변이 여러 개 있어도 첨부·양식 표지는 한 번만 해석합니다. */
  function questionContent(turn: ChatTurn): QuestionContent {
    const cached = parsed.get(turn);
    if (cached) return cached;
    const question = splitQuestion(turn.content);
    parsed.set(turn, question);
    return question;
  }
  let previous: ChatTurn | null = null;
  return turns.map((turn: ChatTurn): ChatMessage => {
    if (turn.role === 'user') {
      previous = turn;
      return {
        kind: 'question',
        turn,
        question: questionContent(turn),
        citations: citations.get(turn.id) ?? turn.citations ?? [],
      };
    }
    // 명시된 reply_to가 없어진 경우 다른 질문으로 추정 연결하지 않습니다.
    const question = turn.reply_to ? questions.get(turn.reply_to) : previous;
    return {
      kind: 'answer',
      turn,
      question: question ? questionContent(question) : null,
      questionTurnId: question?.id ?? null,
      citations: citations.get(turn.id) ?? turn.citations ?? [],
    };
  });
}
