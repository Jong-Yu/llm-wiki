import type {
  DocumentContentRequest,
  DocumentContentResult,
  DocumentListRequest,
  DocumentListResult,
  DocumentsBridge,
  SourcePreviewRequest,
  SourcePreviewResult,
} from '@contracts/documents.contract';

/** 데스크톱이 제공하는 목록 bridge만 선택해 renderer의 인증 요청을 제한합니다. */
function getDocumentsBridge(): DocumentsBridge {
  if (!window.wiki?.documents)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.documents;
}

/** 현재 연결의 문서 목록 조회를 공개 계약에 따라 전달합니다. */
export const documentsGateway: DocumentsBridge = {
  list: async (request: DocumentListRequest): Promise<DocumentListResult> =>
    getDocumentsBridge().list(request),
  /** 현재 연결이 허용한 문서의 전체 본문을 요청합니다. */
  content: async (
    request: DocumentContentRequest,
  ): Promise<DocumentContentResult> => getDocumentsBridge().content(request),
  /** 서버 경로 대신 목록의 불변 원본 참조로 미리보기를 요청합니다. */
  sourcePreview: async (
    request: SourcePreviewRequest,
  ): Promise<SourcePreviewResult> =>
    getDocumentsBridge().sourcePreview(request),
};
