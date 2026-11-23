import { documentTasksGateway } from '@renderer/platform/documentTasks';
import { analysisGateway } from '@renderer/platform/analysis';
import type {
  DocumentTaskSession,
  DocumentTaskReadRequest,
  DocumentTaskListResult,
  DocumentTaskDetailResult,
} from '@contracts/documentTasks.contract';
import type {
  AnalysisListRequest,
  AnalysisPageResult,
} from '@contracts/analysis.contract';

/** 작업 페이지는 이 읽기 전용 adapter로 보호 기록과 서버 분석을 조합합니다. */
export const documentTaskApi = {
  list: (request: DocumentTaskSession): Promise<DocumentTaskListResult> =>
    documentTasksGateway.list(request),
  read: (request: DocumentTaskReadRequest): Promise<DocumentTaskDetailResult> =>
    documentTasksGateway.read(request),
  listAnalyses: (request: AnalysisListRequest): Promise<AnalysisPageResult> =>
    analysisGateway.list(request),
};
