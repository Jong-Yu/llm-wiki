import type {
  ConnectRequest,
  AccountRequest,
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

/** 변경 완료를 앱 프레임과 열린 화면에 알려 이전 계정 화면을 즉시 내립니다. */
async function changed(
  result: Promise<ConnectionResult>,
): Promise<ConnectionResult> {
  try {
    return await result;
  } finally {
    window.dispatchEvent(new Event('wiki-connection-changed'));
  }
}

/** renderer에 공개된 연결 명령만 타입 계약에 맞춰 전달합니다. */
export const connectionGateway: ConnectionBridge = {
  authenticate: async (request: AccountRequest): Promise<ConnectionResult> =>
    changed(getConnectionBridge().authenticate(request)),
  restoreSaved: async (): Promise<ConnectionResult> =>
    changed(getConnectionBridge().restoreSaved()),
  forgetSaved: async (): Promise<ConnectionResult> =>
    getConnectionBridge().forgetSaved(),
  connect: async (request: ConnectRequest): Promise<ConnectionResult> =>
    getConnectionBridge().connect(request),
  getState: async (): Promise<ConnectionResult> =>
    getConnectionBridge().getState(),
  selectWorkspace: async (
    request: SelectWorkspaceRequest,
  ): Promise<ConnectionResult> =>
    changed(getConnectionBridge().selectWorkspace(request)),
  disconnect: async (): Promise<ConnectionResult> =>
    changed(getConnectionBridge().disconnect()),
};
