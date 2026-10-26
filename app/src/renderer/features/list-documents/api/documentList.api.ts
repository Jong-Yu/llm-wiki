import type {
  ConnectionResult,
  WorkspaceMembership,
  WorkspaceProfile,
} from '@contracts/connection.contract';
import type {
  DocumentListPage,
  DocumentListResult,
  DocumentContentResult,
} from '@contracts/documents.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';

export type DocumentListScope = DocumentListPage['access'] & {
  connectionId: string;
  serverUrl: string;
  canRegisterSource: boolean;
  canEditWiki: boolean;
};
export type DocumentListError = Extract<
  DocumentListResult,
  { ok: false }
>['error'];
export type DocumentPageOutcome =
  | { status: 'unselected' }
  | { status: 'ready'; scope: DocumentListScope; page: DocumentListPage }
  | {
      status: 'error';
      scope: DocumentListScope | null;
      error: DocumentListError;
    };

/** main이 확인한 현재 선택을 표시/응답 대조에 필요한 범위로 옮깁니다. */
export function selectedScope(
  result: ConnectionResult,
): DocumentListScope | null {
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  const session = result.data;
  const selection = session.selection;
  if (!selection) return null;
  const workspace = session.workspaces.find(
    (item: WorkspaceMembership): boolean => item.id === selection.tenant,
  );
  if (!workspace || !workspace.permissions.includes('read')) return null;
  const profile = workspace.profiles.find(
    (item: WorkspaceProfile): boolean => item.id === selection.profile,
  );
  if (!profile) return null;
  return {
    connectionId: session.connectionId,
    serverUrl: session.serverUrl,
    canRegisterSource: workspace.permissions.includes('source_write'),
    canEditWiki: workspace.permissions.includes('write'),
    userId: session.userId,
    tenant: selection.tenant,
    profileId: selection.profile,
    policyRevision: session.policyRevision,
    domain: profile.domain,
    viewpoint: profile.viewpoint,
  };
}

/** 이전 페이지의 cursor를 다른 주체/공간/관점에서 재사용하지 않습니다. */
export function sameScope(
  left: DocumentListScope,
  right: DocumentListScope,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    left.policyRevision === right.policyRevision &&
    left.domain === right.domain &&
    left.viewpoint === right.viewpoint
  );
}

/** 목록의 실제 응답 범위와 조회 완료 시점의 main 선택을 대조합니다. */
function pageMatchesScope(
  page: DocumentListPage,
  scope: DocumentListScope,
): boolean {
  return (
    page.connectionId === scope.connectionId &&
    page.scope.tenant === scope.tenant &&
    page.access.userId === scope.userId &&
    page.access.tenant === scope.tenant &&
    page.access.profileId === scope.profileId &&
    page.access.policyRevision === scope.policyRevision &&
    page.access.domain === scope.domain &&
    page.access.viewpoint === scope.viewpoint
  );
}

/** 조회 전후의 연결을 확인하며 실패를 빈 성공이나 자동 재전송으로 바꾸지 않습니다. */
export async function loadDocumentPage(
  cursor: string | null,
  expectedScope: DocumentListScope | undefined,
): Promise<DocumentPageOutcome> {
  try {
    const beforeResult = await connectionGateway.getState();
    if (!beforeResult.ok)
      return { status: 'error', scope: null, error: beforeResult.error };
    const before = selectedScope(beforeResult);
    if (!before) return { status: 'unselected' };
    if (expectedScope && !sameScope(expectedScope, before)) {
      return {
        status: 'error',
        scope: before,
        error: {
          code: 'scope_changed',
          message:
            '작업 공간이나 관점이 바뀌었습니다. 새로고침으로 첫 페이지부터 확인해 주세요.',
        },
      };
    }
    const result = await documentsGateway.list({
      connectionId: before.connectionId,
      cursor,
      limit: 20,
    });
    const afterResult = await connectionGateway.getState();
    const after = selectedScope(afterResult);
    if (!result.ok)
      return { status: 'error', scope: after, error: result.error };
    if (
      !after ||
      before.connectionId !== after.connectionId ||
      before.userId !== after.userId ||
      before.tenant !== after.tenant ||
      before.profileId !== after.profileId ||
      !pageMatchesScope(result.data, after)
    ) {
      return {
        status: 'error',
        scope: after,
        error: {
          code: 'scope_changed',
          message:
            '조회 중 연결 범위가 변경되어 목록을 숨겼습니다. 현재 범위에서 새로고침해 주세요.',
        },
      };
    }
    return { status: 'ready', scope: after, page: result.data };
  } catch {
    return {
      status: 'error',
      scope: null,
      error: {
        code: 'bridge_unavailable',
        message:
          '문서 목록을 확인할 수 없습니다. 앱의 서버 연결 상태를 확인해 주세요.',
      },
    };
  }
}

/** 링크/검색에서 선택한 문서는 실제 본문 API 판본을 확인한 뒤 목록에 추가합니다. */
export async function loadLinkedDocument(
  document: string,
  expected: DocumentListScope,
): Promise<DocumentContentResult> {
  const before = selectedScope(await connectionGateway.getState());
  if (!before || !sameScope(before, expected))
    return {
      ok: false,
      error: {
        code: 'scope_changed',
        message: '문서를 여는 동안 조회 범위가 변경되었습니다.',
      },
    };
  const result = await documentsGateway.content({
    connectionId: expected.connectionId,
    document,
  });
  const after = selectedScope(await connectionGateway.getState());
  if (!after || !sameScope(before, after))
    return {
      ok: false,
      error: {
        code: 'scope_changed',
        message: '문서를 여는 동안 조회 범위가 변경되었습니다.',
      },
    };
  if (
    result.ok &&
    (result.data.document !== document ||
      result.data.access.tenant !== expected.tenant ||
      result.data.access.userId !== expected.userId ||
      result.data.access.profileId !== expected.profileId ||
      result.data.access.policyRevision !== expected.policyRevision)
  )
    return {
      ok: false,
      error: {
        code: 'scope_changed',
        message: '현재 문서의 조회 범위를 확인할 수 없습니다.',
      },
    };
  return result;
}
