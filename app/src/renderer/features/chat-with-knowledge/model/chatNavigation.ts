import type { ChatThread } from './chatState';

export type ChatLocation = {
  conversationId?: string;
  questionRunId?: string;
  threadId?: string;
  document?: string;
  answer?: string;
  evidence?: string;
  panel?: 'history';
};

/** 주소의 대화·근거 선택만 읽고 문서 본문이나 인증정보는 이동 상태에 넣지 않습니다. */
export function readChatLocation(params: URLSearchParams): ChatLocation {
  return {
    conversationId: params.get('conversationId') ?? undefined,
    questionRunId: params.get('questionRunId') ?? undefined,
    threadId: params.get('threadId') ?? undefined,
    document: params.get('document') ?? params.get('path') ?? undefined,
    answer: params.get('answer') ?? undefined,
    evidence: params.get('evidence') ?? undefined,
    panel: params.get('panel') === 'history' ? 'history' : undefined,
  };
}

/** 저장 대화와 아직 전송하지 않은 초안은 서로 다른 참조로 다시 엽니다. */
export function chatLocationForThread(thread: ChatThread): ChatLocation {
  return thread.conversationId
    ? {
        conversationId: thread.conversationId,
        questionRunId: thread.runId ?? undefined,
      }
    : { threadId: thread.id };
}

/** 선택 변경은 명시 주소로 만들며 근거·목록 선택을 함께 보존할 수 있습니다. */
export function chatLocationSearch(location: ChatLocation): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(location)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}
