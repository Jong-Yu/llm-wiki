import type {
  DocumentKnowledgeRequest,
  DocumentKnowledgeResult,
  KnowledgeBridge,
} from '@contracts/knowledge.contract';

/** 지식 조회는 main의 선택 범위에서만 실행되며 renderer에 인증 정보를 열지 않습니다. */
function getKnowledgeBridge(): KnowledgeBridge {
  if (!window.wiki?.knowledge)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.knowledge;
}

export const knowledgeGateway: KnowledgeBridge = {
  read: async (
    request: DocumentKnowledgeRequest,
  ): Promise<DocumentKnowledgeResult> => getKnowledgeBridge().read(request),
};
