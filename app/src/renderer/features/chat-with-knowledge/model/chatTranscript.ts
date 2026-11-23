import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { QuestionAnswer } from '@contracts/questionRuns.contract';
import type { ChatPending, ChatTurn } from './chatState';
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

export type SubmittedChatQuestion = { id: string; content: string };
export type SubmittedChatDraft = SubmittedChatQuestion & { threadId: string };

/** 접수 중인 질문을 표시하고, 보호 복구 후에도 실제 저장된 질문과 중복하지 않습니다. */
export function visibleSubmittedQuestion(
  submitted: SubmittedChatDraft | null,
  pending: ChatPending | null,
  threadId: string,
  turns: readonly ChatTurn[],
): SubmittedChatQuestion | null {
  const candidate =
    submitted?.threadId === threadId
      ? submitted
      : pending?.threadId === threadId &&
          pending.step === 'question' &&
          pending.sentQuestion !== undefined
        ? { id: pending.requestId, content: pending.sentQuestion }
        : null;
  return candidate &&
    !turns.some((turn: ChatTurn): boolean => turn.id === candidate.id)
    ? candidate
    : null;
}

/** 질문·답변 대응과 인용 우선순위를 한 번 계산해 본문과 근거 패널이 같은 자료를 표시합니다. */
export function buildChatTranscript(
  turns: readonly ChatTurn[],
  answers: readonly QuestionAnswer[],
): ChatMessage[] {
  const questions = new Map<string, ChatTurn>();
  const messages = new Map(
    turns.map((turn: ChatTurn): [string, ChatTurn] => [turn.id, turn]),
  );
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
    // 추가 질문의 응답은 별도 첨부/템플릿 규약을 합치지 않은 사용자 원문입니다.
    const question: QuestionContent = turn.clarification_turn_id
      ? {
          question: turn.content,
          attachments: [],
          template: null,
          noEvidence: false,
        }
      : splitQuestion(turn.content);
    parsed.set(turn, question);
    return question;
  }
  /** 추가 질문의 응답도 원래 질문에 고정한 첨부·템플릿 표시를 이어 받습니다. */
  function originalQuestion(turn: ChatTurn): ChatTurn {
    let current = turn;
    const seen = new Set<string>();
    while (current.clarification_turn_id && !seen.has(current.id)) {
      seen.add(current.id);
      const clarification = messages.get(current.clarification_turn_id);
      const parent =
        clarification?.clarification && clarification.reply_to
          ? questions.get(clarification.reply_to)
          : undefined;
      if (!parent) break;
      current = parent;
    }
    return current;
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
      question: question ? questionContent(originalQuestion(question)) : null,
      questionTurnId: question?.id ?? null,
      citations: citations.get(turn.id) ?? turn.citations ?? [],
    };
  });
}
