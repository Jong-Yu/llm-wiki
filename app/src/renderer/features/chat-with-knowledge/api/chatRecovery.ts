import { createRecoverySlot } from '@renderer/platform/recovery';
import type { QuestionSession } from '@contracts/questionRuns.contract';
import { chatRecoverySchema } from '../model/chatState';
import type { ChatRecovery } from '../model/chatState';

/** 기존 OS 보호 복구 저장소에 신규 채팅의 독립 키를 연결합니다. */
export function createChatRecovery(
  session: QuestionSession,
): ReturnType<typeof createRecoverySlot<ChatRecovery>> {
  return createRecoverySlot(
    { connectionId: session.connectionId, ...session.expectedScope },
    'question-runs',
    // 기존에 보호 저장한 대화를 찾는 키이므로 화면 경로와 함께 바꾸지 않습니다.
    'renewal-chat',
    (value: unknown): ChatRecovery => chatRecoverySchema.parse(value),
  );
}
