import type {
  AnalysisBridge,
  AnalysisExecuteRequest,
  AnalysisExecutionInspectionResult,
  AnalysisListRequest,
  AnalysisStartRequest,
  AnalysisReadRequest,
  AnalysisCancelRequest,
  AnalysisPageResult,
  AnalysisDetailResult,
} from '@contracts/analysis.contract';

/** renderer에서는 정해진 분석 동작만 사용하고 main의 실행 명령이나 토큰은 읽지 않습니다. */
function getAnalysisBridge(): AnalysisBridge {
  if (!window.wiki?.analysis) throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.analysis;
}

/** 작업 조회는 AI 실행과 분리되어 있으며 start를 눌렀을 때만 새 실행을 요청합니다. */
export const analysisGateway: AnalysisBridge = {
  inspectExecution: async (
    request: AnalysisReadRequest,
  ): Promise<AnalysisExecutionInspectionResult> =>
    getAnalysisBridge().inspectExecution(request),
  execute: async (
    request: AnalysisExecuteRequest,
  ): Promise<AnalysisDetailResult> => getAnalysisBridge().execute(request),
  stopLocal: async (
    request: AnalysisReadRequest,
  ): Promise<AnalysisDetailResult> => getAnalysisBridge().stopLocal(request),
  list: async (request: AnalysisListRequest): Promise<AnalysisPageResult> =>
    getAnalysisBridge().list(request),
  start: async (request: AnalysisStartRequest): Promise<AnalysisDetailResult> =>
    getAnalysisBridge().start(request),
  read: async (request: AnalysisReadRequest): Promise<AnalysisDetailResult> =>
    getAnalysisBridge().read(request),
  cancel: async (
    request: AnalysisCancelRequest,
  ): Promise<AnalysisDetailResult> => getAnalysisBridge().cancel(request),
};
