import type {
  QuestionRunsBridge,
  QuestionCreateRequest,
  QuestionCreationReceiptRequest,
  QuestionListRequest,
  QuestionReadRequest,
  QuestionStartRequest,
  QuestionCancelRequest,
  QuestionDetailResult,
  QuestionPageResult,
  QuestionResumableRequest,
  QuestionResumableResult,
  QuestionSearchTermsRequest,
  QuestionSearchTermsResult,
  QuestionWebSearchRequest,
  QuestionWebSearchResult,
} from '@contracts/questionRuns.contract';

/** 현재 창의 제한된 작업 bridge만 선택하고 실행 경로와 인증은 main에 둡니다. */
function getBridge(): QuestionRunsBridge {
  if (!window.wiki?.questionRuns)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.questionRuns;
}
export const questionRunsGateway: QuestionRunsBridge = {
  create: async (
    request: QuestionCreateRequest,
  ): Promise<QuestionDetailResult> => getBridge().create(request),
  creationReceipt: async (
    request: QuestionCreationReceiptRequest,
  ): Promise<QuestionDetailResult> => getBridge().creationReceipt(request),
  list: async (request: QuestionListRequest): Promise<QuestionPageResult> =>
    getBridge().list(request),
  read: async (request: QuestionReadRequest): Promise<QuestionDetailResult> =>
    getBridge().read(request),
  start: async (request: QuestionStartRequest): Promise<QuestionDetailResult> =>
    getBridge().start(request),
  cancel: async (
    request: QuestionCancelRequest,
  ): Promise<QuestionDetailResult> => getBridge().cancel(request),
  resumable: async (
    request: QuestionResumableRequest,
  ): Promise<QuestionResumableResult> => getBridge().resumable(request),
  searchTerms: async (
    request: QuestionSearchTermsRequest,
  ): Promise<QuestionSearchTermsResult> => getBridge().searchTerms(request),
  webSearch: async (
    request: QuestionWebSearchRequest,
  ): Promise<QuestionWebSearchResult> => getBridge().webSearch(request),
};
