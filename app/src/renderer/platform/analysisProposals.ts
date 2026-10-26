import type {
  AnalysisProposalsBridge,
  AnalysisProposalRequest,
  AnalysisProposalResult,
} from '@contracts/analysisProposals.contract';

/** 현재 창의 제한된 작업 bridge만 선택하고 실행 경로와 인증은 main에 둡니다. */
function getBridge(): AnalysisProposalsBridge {
  if (!window.wiki?.analysisProposals)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.analysisProposals;
}
export const analysisProposalsGateway: AnalysisProposalsBridge = {
  execute: async (
    request: AnalysisProposalRequest,
  ): Promise<AnalysisProposalResult> => getBridge().execute(request),
};
