import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import { ReadQueryError } from '@renderer/shared/lib/readQueries';
import { documentsGateway } from '@renderer/platform/documents';
import type {
  DocumentContentRequest,
  DocumentContentResult,
} from '@contracts/documents.contract';
import { documentTasksGateway } from '@renderer/platform/documentTasks';
import { analysisGateway } from '@renderer/platform/analysis';
import type {
  DocumentTask,
  DocumentTaskSession,
  DocumentTaskReadRequest,
  DocumentTaskListResult,
  DocumentTaskDetailResult,
} from '@contracts/documentTasks.contract';
import type {
  AnalysisJob,
  AnalysisDetail,
  AnalysisListRequest,
  AnalysisReadRequest,
  AnalysisExecuteRequest,
  AnalysisDetailResult,
  AnalysisExecutionInspectionResult,
  AnalysisPageResult,
} from '@contracts/analysis.contract';

/** 문자 확인 뒤 별도 접수된 작업은 같은 원본·보고·대상의 서버 근거로만 찾아 표시합니다. */
async function findReviewedAnalysis(
  connectionId: string,
  task: DocumentTask,
  reference: NonNullable<SourceConversionRun['reference']>,
): Promise<AnalysisDetail | null> {
  function matches(job: AnalysisJob): boolean {
    return (
      job.source_ref.source_id === task.source.sourceId &&
      job.source_ref.source_version === task.source.sourceVersion &&
      job.source_ref.source_sha256 === task.source.sourceSha256 &&
      job.source_ref.registration_revision ===
        task.source.registrationRevision &&
      job.targets.length === 1 &&
      job.targets[0].document === task.targetDocument &&
      job.registration?.conversion_ref?.conversion_id ===
        reference.conversionId &&
      job.registration.conversion_ref.conversion_revision ===
        reference.conversionRevision
    );
  }
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const listed = await analysisGateway.list({
      connectionId,
      sourceId: task.source.sourceId,
      cursor,
    });
    if (!listed.ok) throw new ReadQueryError(listed.error);
    if (
      listed.data.requiresRefresh ||
      listed.data.truncated ||
      listed.data.skippedCount > 0
    )
      throw new Error('진행 기록이 바뀌었습니다. 다시 확인해 주세요.');
    const candidate = listed.data.items.find(matches);
    if (candidate) {
      const current = await analysisGateway.read({
        connectionId,
        jobId: candidate.job_id,
      });
      if (!current.ok) throw new ReadQueryError(current.error);
      if (!matches(current.data.job))
        throw new Error(
          '진행 기록의 원본 또는 등록 내용이 바뀌었습니다. 다시 확인해 주세요.',
        );
      return current.data;
    }
    cursor = listed.data.nextCursor;
    if (!cursor) return null;
  }
  throw new Error('진행 기록을 모두 확인하지 못했습니다. 다시 확인해 주세요.');
}

/** 문서 진행 페이지의 조회와 명시 재개를 기존 보호 bridge로 전달합니다. */
export const documentTaskApi = {
  findReviewedAnalysis,
  readDocument: (
    request: DocumentContentRequest,
  ): Promise<DocumentContentResult> => documentsGateway.content(request),
  readAnalysis: (request: AnalysisReadRequest): Promise<AnalysisDetailResult> =>
    analysisGateway.read(request),
  inspectAnalysis: (
    request: AnalysisReadRequest,
  ): Promise<AnalysisExecutionInspectionResult> =>
    analysisGateway.inspectExecution(request),
  executeAnalysis: (
    request: AnalysisExecuteRequest,
  ): Promise<AnalysisDetailResult> => analysisGateway.execute(request),
  list: (request: DocumentTaskSession): Promise<DocumentTaskListResult> =>
    documentTasksGateway.list(request),
  read: (request: DocumentTaskReadRequest): Promise<DocumentTaskDetailResult> =>
    documentTasksGateway.read(request),
  listAnalyses: (request: AnalysisListRequest): Promise<AnalysisPageResult> =>
    analysisGateway.list(request),
};
