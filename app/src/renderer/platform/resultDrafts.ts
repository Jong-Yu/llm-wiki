import type {
  ResultDraftBridge,
  ResultDraftRequest,
  ResultDraftResult,
} from '@contracts/resultDrafts.contract';

/** 현재 창에 허용된 초안 명령만 호출하고 주소와 인증정보는 main에 둡니다. */
function getResultDraftBridge(): ResultDraftBridge {
  if (!window.wiki?.resultDrafts)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.resultDrafts;
}
export const resultDraftsGateway: ResultDraftBridge = {
  execute: async (request: ResultDraftRequest): Promise<ResultDraftResult> =>
    getResultDraftBridge().execute(request),
};
