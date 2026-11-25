import { useRef } from 'react';
import { saveAnswerArtifact } from '../api/knowledgeChat.api';
import type { AnswerArtifact, ChatAccess } from '../api/knowledgeChat.api';
import { chatTurns } from './chatState';
import type { ChatEnvelope, ChatTurn } from './chatState';

/** 같은 답변의 저장을 합치고 완료 결과를 재사용합니다. 캐시는 호출한 채팅의 접근 범위 수명을 따릅니다. */
export function useAnswerArtifacts(
  access: ChatAccess,
  conversation: ChatEnvelope | null,
  threadTitle: string,
): (turn: ChatTurn) => Promise<AnswerArtifact | null> {
  const { session } = access;
  // 답변 턴 ID별 내 폴더 저장 결과와 진행 중 요청입니다. 같은 답변은 한 번만 저장합니다.
  const savedAnswers = useRef(new Map<string, AnswerArtifact>());
  const savingAnswers = useRef(
    new Map<string, Promise<AnswerArtifact | null>>(),
  );
  /**
   * 완료·진행 중 결과를 먼저 재사용하고, 새 저장이 불가능하거나 실패하면 null을 돌려줍니다.
   * 오류를 던지지 않아 답변 표시와 내려받기를 유지하며 호출자가 저장 확인 필요 여부를 구별합니다.
   */
  return function ensureAnswerArtifact(
    turn: ChatTurn,
  ): Promise<AnswerArtifact | null> {
    const done = savedAnswers.current.get(turn.id);
    if (done) return Promise.resolve(done);
    const running = savingAnswers.current.get(turn.id);
    if (running) return running;
    const conversationId = conversation?.record.id;
    if (
      !conversationId ||
      turn.role !== 'assistant' ||
      turn.status === 'failed' ||
      !turn.content.trim() ||
      !access.permissions.includes('result_write')
    )
      return Promise.resolve(null);
    const number =
      chatTurns(conversation)
        .filter((item: ChatTurn): boolean => item.role === 'assistant')
        .findIndex((item: ChatTurn): boolean => item.id === turn.id) + 1;
    const title = `${threadTitle}${number > 1 ? ` (${number})` : ''}`;
    const request = saveAnswerArtifact(session, {
      conversationId,
      turnId: turn.id,
      title,
    })
      .then((saved: AnswerArtifact): AnswerArtifact => {
        savedAnswers.current.set(turn.id, saved);
        return saved;
      })
      .catch((): null => null)
      .finally((): void => {
        savingAnswers.current.delete(turn.id);
      });
    savingAnswers.current.set(turn.id, request);
    return request;
  };
}
