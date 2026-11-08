import type {
  AiSessionsBridge,
  AiSessionsReadRequest,
  AiSessionsResult,
} from '@contracts/aiSessions.contract';

/** 현재 앱의 공개 실행 상태와 계정 사용량만 읽습니다. */
export const aiSessionsGateway: AiSessionsBridge = {
  read: async (request: AiSessionsReadRequest): Promise<AiSessionsResult> => {
    if (!window.wiki?.aiSessions)
      return {
        ok: false,
        error: {
          code: 'sessions_unavailable',
          message: '이 실행 환경은 AI 세션 상태 조회를 지원하지 않습니다.',
        },
      };
    return window.wiki.aiSessions.read(request);
  },
};
