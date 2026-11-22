import type { ConnectionResult } from '@contracts/connection.contract';
import type { RuntimeResult } from '@contracts/runtime.contract';
let connection: ConnectionResult = {
  ok: true,
  data: {
    status: 'connected',
    connectionId: 'workspace-admin-preview',
    serverUrl: 'https://wiki.example.com',
    userId: 'example-user',
    displayName: '김민서',
    policyRevision: 'example',
    checkedAt: '2026-11-16T00:00:00Z',
    selection: { tenant: 'sdv-platform', profile: 'default' },
    workspaces: [
      {
        id: 'sdv-platform',
        displayName: 'SDV 플랫폼',
        permissions: ['read'],
        defaultProfile: 'default',
        profiles: [{ id: 'default', domain: null, viewpoint: null }],
      },
    ],
  },
};
export const previewRuntime: RuntimeResult = {
  ok: true,
  data: {
    settings: {
      root: '',
      python: '',
      provider: 'codex',
      codex: '',
      claude: '',
      tesseract: '',
      tessdata: '',
      models: { codex: 'default', claude: 'default' },
    },
    activeProvider: 'codex',
    activeModel: 'default',
    restartRequired: false,
    saved: true,
    issue: null,
    checks: [],
    platform: 'darwin',
    cliConnection: {
      provider: 'codex',
      status: 'connected',
      message: '',
      code: null,
    },
  },
};
/** 설정 진입 시 일반 계정의 표시만 바꾸며 관리자 인증과 분리합니다. */
export function setPreviewAccount(name: string, serverUrl: string): void {
  if (!connection.ok || connection.data.status !== 'connected') return;
  connection = {
    ok: true,
    data: { ...connection.data, displayName: name, serverUrl },
  };
  window.dispatchEvent(new Event('wiki-connection-changed'));
}
/** 운영 API를 호출하지 않는 공개 모의 연결입니다. */
Object.defineProperty(window, 'wiki', {
  value: {
    connection: {
      getState: async (): Promise<ConnectionResult> => connection,
      selectWorkspace: async (): Promise<ConnectionResult> => connection,
    },
    runtime: { execute: async (): Promise<RuntimeResult> => previewRuntime },
    aiSessions: {
      read: async (): Promise<unknown> => ({
        ok: false,
        error: {
          code: 'preview',
          message: '시안에서는 실제 실행을 조회하지 않습니다.',
        },
      }),
    },
  },
});
