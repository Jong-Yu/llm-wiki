import type {
  KnowledgeComparisonsBridge,
  KnowledgeComparisonListRequest,
  KnowledgeComparisonReadRequest,
  KnowledgeComparisonRestartRequest,
  KnowledgeComparisonPageResult,
  KnowledgeComparisonDetailResult,
} from '@contracts/knowledgeComparisons.contract';

/** 제한된 대조 bridge만 사용하고 서버 주소·인증·실행 경로는 main에 둡니다. */
function bridge(): KnowledgeComparisonsBridge {
  if (!window.wiki?.knowledgeComparisons)
    throw new Error(
      '현재 실행 환경은 기존 지식 대조 조회를 지원하지 않습니다.',
    );
  return window.wiki.knowledgeComparisons;
}
export const knowledgeComparisonsGateway: KnowledgeComparisonsBridge = {
  list: (
    request: KnowledgeComparisonListRequest,
  ): Promise<KnowledgeComparisonPageResult> => bridge().list(request),
  read: (
    request: KnowledgeComparisonReadRequest,
  ): Promise<KnowledgeComparisonDetailResult> => bridge().read(request),
  restart: (
    request: KnowledgeComparisonRestartRequest,
  ): Promise<KnowledgeComparisonDetailResult> => bridge().restart(request),
  stopLocal: (
    request: KnowledgeComparisonReadRequest,
  ): Promise<KnowledgeComparisonDetailResult> => bridge().stopLocal(request),
};
