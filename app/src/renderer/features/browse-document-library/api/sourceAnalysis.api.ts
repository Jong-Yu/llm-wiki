import type { AnalysisJob } from '@contracts/analysis.contract';
import { analysisGateway } from '@renderer/platform/analysis';
import {
  documentTasksGateway,
  hasDocumentTaskBridge,
} from '@renderer/platform/documentTasks';
import { documentTaskPath } from '@renderer/shared/lib/workflowNavigation';
import type { LibraryScope } from '../model/documentLibrary.types';

/** 원본 목록 행에 보이는 분석 상태입니다. none은 이 판본에 접수된 작업이 없다는 뜻입니다. */
export type SourceAnalysisKind =
  | 'none'
  | 'running'
  | 'pending'
  | 'complete'
  | 'attention';
export type SourceAnalysis = {
  kind: Exclude<SourceAnalysisKind, 'none'>;
  jobId: string;
  progressPath?: string;
};
export type SourceAnalysisIndex = {
  /** `sourceId:sourceVersion` 키별 대표 작업입니다. */
  bySource: Map<string, SourceAnalysis>;
  /** 모든 작업 페이지를 읽었는지 여부입니다. 아니면 "분석 전"을 단정하지 않습니다. */
  complete: boolean;
};

/** 읽는 작업 페이지의 상한입니다(페이지당 20건). 초과하면 불완전으로 표시합니다. */
const maxPages = 20;

export function sourceAnalysisKey(
  sourceId: string,
  sourceVersion: string,
): string {
  return `${sourceId}:${sourceVersion}`;
}

/** 서버 영수증과 실행 보고를 목록용 네 가지 상태로 줄입니다. 저장 완료만 "완료"로 봅니다. */
export function sourceAnalysisKind(job: AnalysisJob): SourceAnalysis['kind'] {
  const result = job.result_summary.status;
  if (result === 'complete') return 'complete';
  if (result === 'pending_reconcile' || result === 'rejected')
    return 'attention';
  if (
    job.state === 'cancelled' ||
    job.reported_status === 'failed' ||
    job.reported_status === 'stopped' ||
    job.reported_status === 'blocked'
  )
    return 'attention';
  if (job.lease_status === 'active') return 'running';
  if (job.state === 'awaiting_cli' && result === 'not_started')
    return 'pending';
  // 실행권이 끝났는데 저장이 일부뿐이거나 진행이 멈춘 작업은 사용자가 확인해야 합니다.
  return 'attention';
}

/** 작업 목록을 모두 읽어 원본 판본별 대표 작업을 정합니다. 조회는 새 실행을 만들지 않습니다. */
export async function readSourceAnalysisIndex(
  connectionId: string,
  scope?: LibraryScope,
): Promise<SourceAnalysisIndex> {
  const best = new Map<string, { entry: SourceAnalysis; createdAt: string }>();
  let cursor: string | null = null;
  let complete = true;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await analysisGateway.list({
      connectionId,
      sourceId: null,
      cursor,
    });
    if (!result.ok) throw new Error(result.error.message);
    const value = result.data;
    if (value.truncated || value.skippedCount > 0 || value.requiresRefresh)
      complete = false;
    for (const job of value.items) {
      const key = sourceAnalysisKey(
        job.source_ref.source_id,
        job.source_ref.source_version,
      );
      const entry: SourceAnalysis = {
        kind: sourceAnalysisKind(job),
        jobId: job.job_id,
      };
      const current = best.get(key);
      if (!current || job.created_at > current.createdAt)
        best.set(key, { entry, createdAt: job.created_at });
    }
    cursor = value.nextCursor;
    if (cursor === null) break;
    if (page === maxPages - 1) complete = false;
  }
  if (scope && hasDocumentTaskBridge()) {
    try {
      const records = await documentTasksGateway.list({
        connectionId,
        expectedScope: {
          userId: scope.userId,
          tenant: scope.tenant,
          profileId: scope.profileId,
          policyRevision: scope.policyRevision,
          ...(scope.accessRevision
            ? { accessRevision: scope.accessRevision }
            : {}),
        },
      });
      if (!records.ok) complete = false;
      else
        for (const task of records.data.items) {
          const key = sourceAnalysisKey(
            task.source.sourceId,
            task.source.sourceVersion,
          );
          const current = best.get(key);
          if (
            current &&
            current.entry.jobId !== task.registration.jobId &&
            current.createdAt > task.createdAt
          )
            continue;
          const conversion = task.conversions.at(-1);
          const summary = task.analysisSummary;
          const kind: SourceAnalysis['kind'] =
            current?.entry.jobId === task.registration.jobId
              ? current.entry.kind
              : task.registration.state === 'unconfirmed'
                ? 'attention'
                : conversion &&
                    ['running', 'cancelling'].includes(conversion.state)
                  ? 'running'
                  : conversion && conversion.state !== 'complete'
                    ? 'attention'
                    : summary?.resultStatus === 'complete'
                      ? 'complete'
                      : summary?.reportedStatus === 'failed' ||
                          summary?.reportedStatus === 'stopped' ||
                          summary?.state === 'cancelled' ||
                          task.registration.state === 'rejected'
                        ? 'attention'
                        : task.registration.jobId
                          ? 'attention'
                          : 'pending';
          best.set(key, {
            createdAt: task.createdAt,
            entry: {
              kind,
              jobId: task.registration.jobId ?? '',
              progressPath: documentTaskPath(task.taskId),
            },
          });
        }
    } catch {
      complete = false;
    }
  }
  return {
    bySource: new Map(
      [...best].map(
        ([key, value]: [
          string,
          { entry: SourceAnalysis; createdAt: string },
        ]): [string, SourceAnalysis] => [key, value.entry],
      ),
    ),
    complete,
  };
}
