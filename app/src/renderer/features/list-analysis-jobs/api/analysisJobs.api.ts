import type {
  AnalysisPage,
  AnalysisDetail,
  AnalysisPageResult,
} from '@contracts/analysis.contract';
import type { ConnectionResult } from '@contracts/connection.contract';
import { analysisGateway } from '@renderer/platform/analysis';
import { connectionGateway } from '@renderer/platform/connection';

export type JobsScope = {
  connectionId: string;
  tenant: string;
  profileId: string;
  userId: string;
  policyRevision: string;
};
type Failure = Extract<AnalysisPageResult, { ok: false }>;
export type JobsPageResult =
  | { ok: true; page: AnalysisPage; scope: JobsScope }
  | Failure;
export type JobDetailResult = { ok: true; detail: AnalysisDetail } | Failure;

/** main에 확정된 현재 작업 공간만 선택하며 토큰은 요청하지 않습니다. */
function selectedScope(result: ConnectionResult): JobsScope | null {
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  return {
    connectionId: result.data.connectionId,
    tenant: result.data.selection.tenant,
    profileId: result.data.selection.profile,
    userId: result.data.userId,
    policyRevision: result.data.policyRevision,
  };
}

/** 다른 사용자/관점의 페이지와 작업 상세를 현재 화면에 사용하지 않습니다. */
function sameScope(left: JobsScope | null, right: JobsScope | null): boolean {
  return (
    !!left &&
    !!right &&
    left.connectionId === right.connectionId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    left.userId === right.userId &&
    left.policyRevision === right.policyRevision
  );
}

/** 연결 범위 변경은 저장/작업 실패와 구분해 이전 목록을 숨깁니다. */
function scopeChanged(): Failure {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결 또는 조회 관점이 변경되었습니다. 현재 작업 공간에서 새로고침해 주세요.',
    },
  };
}

/** 원본별 제한 없이 서버의 본인 작업 페이지 전체를 조회합니다. */
export async function loadJobsPage(
  cursor: string | null,
  expected?: JobsScope,
): Promise<JobsPageResult> {
  try {
    const before = selectedScope(await connectionGateway.getState());
    if (!before)
      return {
        ok: false,
        error: {
          code: 'selection_required',
          message: '작업 공간을 먼저 선택해 주세요.',
        },
      };
    if (expected && !sameScope(before, expected)) return scopeChanged();
    const result = await analysisGateway.list({
      connectionId: before.connectionId,
      sourceId: null,
      cursor,
    });
    const after = selectedScope(await connectionGateway.getState());
    if (!sameScope(before, after)) return scopeChanged();
    if (!result.ok) return result;
    return { ok: true, page: result.data, scope: before };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: 'AI 작업 목록을 읽지 못했습니다. 서버 연결을 확인해 주세요.',
      },
    };
  }
}

/** 상세 조회와 명시 취소만 전달하며 이 경로에서 AI를 시작하지 않습니다. */
export async function loadJobDetail(
  scope: JobsScope,
  jobId: string,
  cancelRevision?: string,
): Promise<JobDetailResult> {
  try {
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return scopeChanged();
    const result =
      cancelRevision === undefined
        ? await analysisGateway.read({
            connectionId: scope.connectionId,
            jobId,
          })
        : await analysisGateway.cancel({
            connectionId: scope.connectionId,
            jobId,
            expectedJobRevision: cancelRevision,
          });
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return scopeChanged();
    if (!result.ok) return result;
    if (
      result.data.job.tenant !== scope.tenant ||
      result.data.job.user_id !== scope.userId ||
      result.data.job.job_id !== jobId
    )
      return scopeChanged();
    return { ok: true, detail: result.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '작업 결과를 확인하지 못했습니다. 저장된 결과를 다시 조회해 주세요.',
      },
    };
  }
}
