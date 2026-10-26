import type {
  ConnectRequest,
  ConnectionBridge,
  ConnectionResult,
  SelectWorkspaceRequest,
} from '@contracts/connection.contract';

/** 서버 연결의 한정된 bridge만 노출하며 renderer에서 HTTP나 비밀 저장을 하지 않습니다. */
function getConnectionBridge(): ConnectionBridge {
  if (!window.wiki?.connection)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.connection;
}

/** renderer에 공개된 연결 명령만 타입 계약에 맞춰 전달합니다. */
export const connectionGateway: ConnectionBridge = {
  restoreSaved: async (): Promise<ConnectionResult> =>
    getConnectionBridge().restoreSaved(),
  forgetSaved: async (): Promise<ConnectionResult> =>
    getConnectionBridge().forgetSaved(),
  connect: async (request: ConnectRequest): Promise<ConnectionResult> =>
    getConnectionBridge().connect(request),
  getState: async (): Promise<ConnectionResult> =>
    getConnectionBridge().getState(),
  selectWorkspace: async (
    request: SelectWorkspaceRequest,
  ): Promise<ConnectionResult> =>
    getConnectionBridge().selectWorkspace(request),
  disconnect: async (): Promise<ConnectionResult> =>
    getConnectionBridge().disconnect(),
};
