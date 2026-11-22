import type { ConnectionResult } from '@contracts/connection.contract';

/** 서버에 연결하지 않는 격리 시안용 공개 연결 정보입니다. */
const connection: ConnectionResult = {
  ok: true,
  data: {
    status: 'connected',
    connectionId: 'template-proposal',
    serverUrl: 'http://fixture.invalid',
    userId: 'design-preview',
    policyRevision: 'example',
    displayName: '디자인 검증',
    selection: { tenant: 'nori', profile: 'default' },
    checkedAt: '2026-11-14T00:00:00Z',
    workspaces: [
      {
        id: 'nori',
        displayName: '제품 연구',
        permissions: ['read'],
        defaultProfile: 'default',
        profiles: [{ id: 'default', domain: null, viewpoint: null }],
      },
    ],
  },
};
Object.defineProperty(window, 'wiki', {
  value: {
    fileExports: { formats: ['md', 'txt', 'docx', 'pdf', 'xlsx', 'pptx'] },
    connection: { getState: async (): Promise<ConnectionResult> => connection },
    runtime: {
      execute: async (): Promise<unknown> => ({
        ok: true,
        data: {
          activeProvider: 'claude',
          activeModel: 'default',
          checks: [],
          settings: { models: { claude: 'default', codex: 'default' } },
          cliConnection: {
            status: 'connected',
            provider: 'claude',
            verifiedAt: '2026-11-14T00:00:00Z',
          },
          restartRequired: false,
          saved: true,
          issue: null,
          platform: 'darwin',
        },
      }),
    },
    aiSessions: {
      read: async (): Promise<unknown> => ({
        ok: false,
        error: {
          code: 'unavailable',
          message: 'UI 시안에서는 실제 세션을 조회하지 않습니다.',
        },
      }),
    },
  },
});
