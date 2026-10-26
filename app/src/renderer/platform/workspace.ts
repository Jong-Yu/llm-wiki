import type {
  WorkspaceBridge,
  WorkspaceRequest,
  WorkspaceResult,
} from '@contracts/workspace.contract';

/** 현재 창이 허용한 업무 bridge만 선택하며 URL·메서드를 renderer에 공개하지 않습니다. */
function getWorkspaceBridge(): WorkspaceBridge {
  if (!window.wiki?.workspace)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.workspace;
}

export const workspaceGateway: WorkspaceBridge = {
  execute: async (request: WorkspaceRequest): Promise<WorkspaceResult> =>
    getWorkspaceBridge().execute(request),
};
