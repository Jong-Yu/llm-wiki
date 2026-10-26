import type {
  ConnectionResult,
  WorkspaceMembership,
  WorkspaceProfile,
} from '@contracts/connection.contract';
import type {
  SourceVersions,
  SourceVersionScope,
  SourceVersionsResult,
} from '@contracts/sources.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { sourcesGateway } from '@renderer/platform/sources';
import type { SourcePreviewRequest } from '@contracts/documents.contract';
import type { SourceDownloadResult } from '@contracts/sources.contract';

/** 원본 파일 저장은 main의 native 대화상자에서 처리하고 결과만 받습니다. */
export async function downloadOriginal(
  request: SourcePreviewRequest,
): Promise<SourceDownloadResult> {
  try {
    return await sourcesGateway.download(request);
  } catch {
    return {
      ok: false,
      error: {
        code: 'file_save_failed',
        message: '원본 파일 저장을 확인하지 못했습니다.',
      },
    };
  }
}

type Failure = Extract<SourceVersionsResult, { ok: false }>;
export type SourceCatalogOutcome =
  | { ok: true; data: SourceVersions; canWrite: boolean }
  | Failure;

/** 고정된 선택 문맥만 사용하고 다른 tenant/profile의 판본을 현재 자료로 표시하지 않습니다. */
function sameScope(
  result: ConnectionResult,
  scope: SourceVersionScope,
): boolean {
  if (!result.ok || result.data.status !== 'connected') return false;
  const state = result.data;
  const workspace = state.workspaces.find(
    (item: WorkspaceMembership): boolean => item.id === scope.tenant,
  );
  const profile = workspace?.profiles.find(
    (item: WorkspaceProfile): boolean => item.id === scope.profileId,
  );
  return (
    state.connectionId === scope.connectionId &&
    state.userId === scope.userId &&
    state.policyRevision === scope.policyRevision &&
    state.selection?.tenant === scope.tenant &&
    state.selection.profile === scope.profileId &&
    profile?.domain === scope.domain &&
    profile.viewpoint === scope.viewpoint
  );
}

/** 범위 오류는 부모가 문서 선택과 이전 내용을 함께 숨길 수 있게 고정 코드로 반환합니다. */
function changedScope(): Failure {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '조회 중 연결 또는 권한이 변경되었습니다. 작업 공간을 다시 확인해 주세요.',
    },
  };
}

/** 판본 목록은 전체 응답과 현재 선택을 대조하고 쓰기 권한을 별도로 알려 줍니다. */
export async function loadSourceVersions(
  sourceId: string,
  scope: SourceVersionScope,
): Promise<SourceCatalogOutcome> {
  try {
    if (!sameScope(await connectionGateway.getState(), scope))
      return changedScope();
    const result = await sourcesGateway.versions({
      connectionId: scope.connectionId,
      sourceId,
    });
    const after = await connectionGateway.getState();
    if (!sameScope(after, scope)) return changedScope();
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      result.data.connectionId !== scope.connectionId ||
      result.data.sourceId !== sourceId ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.domain !== scope.domain ||
      access.viewpoint !== scope.viewpoint ||
      access.policyRevision !== scope.policyRevision
    )
      return changedScope();
    const canWrite =
      after.ok &&
      after.data.status === 'connected' &&
      after.data.workspaces.some(
        (item: WorkspaceMembership): boolean =>
          item.id === scope.tenant && item.permissions.includes('source_write'),
      );
    return { ...result, canWrite };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '원본 판본 목록을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.',
      },
    };
  }
}
