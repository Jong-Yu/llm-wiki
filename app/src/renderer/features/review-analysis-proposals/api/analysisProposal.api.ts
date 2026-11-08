import type { WorkspaceScope } from '@contracts/workspace.contract';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { sameAccessRevision } from '@contracts/connection.contract';

export type ProposalScope = WorkspaceScope & {
  connectionId: string;
  permissions: string[];
};
/** 현재 연결·사용자·관점으로 초안의 수명 범위를 결정합니다. */
export async function loadProposalScope(): Promise<ProposalScope> {
  const result = await connectionGateway.getState();
  if (!result.ok) throw new Error(result.error.message);
  const value = result.data;
  if (value.status !== 'connected' || !value.selection)
    throw new Error('서버에 연결하고 작업 공간을 선택해 주세요.');
  const workspace = value.workspaces.find(
    (item: (typeof value.workspaces)[number]): boolean =>
      item.id === value.selection?.tenant,
  );
  if (!workspace) throw new Error('허용된 작업 공간을 다시 확인해 주세요.');
  return {
    connectionId: value.connectionId,
    userId: value.userId,
    tenant: value.selection.tenant,
    profileId: value.selection.profile,
    policyRevision: value.policyRevision,
    ...(value.accessRevision ? { accessRevision: value.accessRevision } : {}),
    permissions: workspace.permissions,
  };
}
/** 저장 인가가 아닌 조회 당시 범위 비교값만 전송합니다. */
export function proposalExpectedScope(scope: ProposalScope): WorkspaceScope {
  return {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
    ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
  };
}
/** 본문·검토의 현재 버전을 읽고 원래 범위와 다른 응답은 숨깁니다. */
export async function loadProposalKnowledge(
  scope: ProposalScope,
  document: string,
): Promise<DocumentKnowledge> {
  const result = await knowledgeGateway.read({
    connectionId: scope.connectionId,
    document,
  });
  if (!result.ok) throw new Error(result.error.message);
  const access = result.data.access;
  if (
    access.userId !== scope.userId ||
    access.tenant !== scope.tenant ||
    access.profileId !== scope.profileId ||
    !sameAccessRevision(access, scope)
  )
    throw new Error(
      '현재 권한 범위가 바뀌었습니다. 이전 초안을 보존하고 연결을 다시 확인해 주세요.',
    );
  return result.data;
}
