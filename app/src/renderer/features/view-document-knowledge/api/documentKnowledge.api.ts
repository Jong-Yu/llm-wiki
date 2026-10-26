import type { ConnectionSnapshot } from '@contracts/connection.contract';
import type {
  DocumentKnowledge,
  DocumentKnowledgeResult,
} from '@contracts/knowledge.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { knowledgeGateway } from '@renderer/platform/knowledge';

export type KnowledgeScope = {
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
  domain?: string | null;
  viewpoint?: string | null;
};
export type KnowledgeError = Extract<
  DocumentKnowledgeResult,
  { ok: false }
>['error'];
export type DocumentKnowledgeOutcome =
  | { status: 'ready'; data: DocumentKnowledge }
  | { status: 'error'; error: KnowledgeError; scopeInvalidated: boolean };

/** 읽기 전후의 main 선택이 요청한 사용자·공간·관점·정책과 같은지 확인합니다. */
function matchesSelection(
  snapshot: ConnectionSnapshot,
  connectionId: string,
  scope: KnowledgeScope,
): boolean {
  return (
    snapshot.status === 'connected' &&
    snapshot.connectionId === connectionId &&
    snapshot.userId === scope.userId &&
    snapshot.policyRevision === scope.policyRevision &&
    snapshot.selection?.tenant === scope.tenant &&
    snapshot.selection.profile === scope.profileId
  );
}

/** 관점의 맥락값이 전달된 경우 응답의 실제 domain/viewpoint까지 대조합니다. */
function matchesResponse(
  data: DocumentKnowledge,
  connectionId: string,
  document: string,
  scope: KnowledgeScope,
): boolean {
  return (
    data.connectionId === connectionId &&
    data.document === document &&
    data.access.userId === scope.userId &&
    data.access.tenant === scope.tenant &&
    data.access.profileId === scope.profileId &&
    data.access.policyRevision === scope.policyRevision &&
    (scope.domain === undefined || data.access.domain === scope.domain) &&
    (scope.viewpoint === undefined || data.access.viewpoint === scope.viewpoint)
  );
}

/** 범위 변경을 빈 지식이나 조회 완료로 표시하지 않습니다. */
function changedScope(): DocumentKnowledgeOutcome {
  return {
    status: 'error',
    scopeInvalidated: true,
    error: {
      code: 'scope_changed',
      message:
        '조회 범위가 변경되어 지식을 숨겼습니다. 현재 작업 공간을 다시 확인해 주세요.',
    },
  };
}

/** 같은 선택 범위의 저장된 지식만 읽고 연결/권한이 바뀐 이전 응답은 숨깁니다. */
export async function loadDocumentKnowledge(
  connectionId: string,
  document: string,
  scope: KnowledgeScope,
): Promise<DocumentKnowledgeOutcome> {
  try {
    const before = await connectionGateway.getState();
    if (!before.ok)
      return { status: 'error', error: before.error, scopeInvalidated: true };
    if (!matchesSelection(before.data, connectionId, scope))
      return changedScope();
    const result = await knowledgeGateway.read({ connectionId, document });
    const after = await connectionGateway.getState();
    if (!after.ok)
      return { status: 'error', error: after.error, scopeInvalidated: true };
    if (!matchesSelection(after.data, connectionId, scope))
      return changedScope();
    if (!result.ok)
      return {
        status: 'error',
        error: result.error,
        scopeInvalidated:
          result.error.status === 401 ||
          result.error.status === 403 ||
          result.error.code === 'scope_changed',
      };
    if (!matchesResponse(result.data, connectionId, document, scope))
      return changedScope();
    return { status: 'ready', data: result.data };
  } catch {
    return {
      status: 'error',
      scopeInvalidated: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '연결된 지식을 조회할 수 없습니다. 앱의 서버 연결 상태를 확인해 주세요.',
      },
    };
  }
}
