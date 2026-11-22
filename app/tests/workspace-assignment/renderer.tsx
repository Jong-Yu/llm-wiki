import { useEffect } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { WorkspaceLogin } from '@renderer/features/configure-workspace-tools/ui/WorkspaceLogin';
import type {
  ConnectionResult,
  ConnectionSnapshot,
} from '@contracts/connection.contract';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
let snapshot: ConnectionSnapshot = { status: 'disconnected' };
let mode = 'waiting';
let mounts = 0;
let refreshes = 0;
let logouts = 0;
let release: (() => void) | undefined;
let releaseInitial: (() => void) | undefined;
let firstRead = true;
const waiting: ConnectionSnapshot = {
  status: 'connected',
  connectionId: 'fixture-connection',
  serverUrl: 'https://wiki.example.com/api/v1/',
  userId: 'waiting-user',
  displayName: '배정 대기 사용자',
  policyRevision: 'a'.repeat(64),
  accessRevision: 'b'.repeat(64),
  workspaces: [],
  selection: null,
  checkedAt: '2026-11-17T00:00:00Z',
  defaultTenant: null,
};
if (location.search.includes('initial-race')) snapshot = waiting;
/** 실제 업무 child가 마운트되는 경계만 계측합니다. */
function WorkspaceProbe(): JSX.Element {
  useEffect((): void => {
    mounts += 1;
  }, []);
  return <main>업무 화면</main>;
}
/** 제품 로그인 게이트의 가이드 예외를 같은 라우팅 조건으로 재현합니다. */
function Harness(): JSX.Element {
  const location = useLocation();
  return (
    <WorkspaceLogin
      publicContent={
        location.pathname === '/guide' ? (
          <main>공개 사용자 가이드</main>
        ) : undefined
      }
    >
      <WorkspaceProbe />
    </WorkspaceLogin>
  );
}
Object.defineProperty(window, 'wiki', {
  value: {
    connection: {
      getState: async (): Promise<ConnectionResult> => {
        const captured = snapshot;
        if (firstRead && location.search.includes('initial-race')) {
          firstRead = false;
          await new Promise<void>((resolve: () => void): void => {
            releaseInitial = resolve;
          });
        }
        firstRead = false;
        return { ok: true, data: captured };
      },
      authenticate: async (): Promise<ConnectionResult> => {
        snapshot = waiting;
        return { ok: true, data: snapshot };
      },
      refreshAccess: async (): Promise<ConnectionResult> => {
        refreshes++;
        const captured = snapshot;
        if (mode === 'delayed') {
          await new Promise<void>((resolve: () => void): void => {
            release = resolve;
          });
          return { ok: true, data: captured };
        }
        if (mode === 'error')
          return {
            ok: false,
            error: { code: 'network_error', message: 'unreachable' },
          };
        if (mode === 'assigned')
          snapshot = {
            ...waiting,
            workspaces: [
              {
                id: 'research',
                displayName: '연구',
                permissions: ['read'],
                defaultProfile: 'default',
                profiles: [{ id: 'default', domain: null, viewpoint: null }],
              },
            ],
            defaultTenant: 'research',
            selection: { tenant: 'research', profile: 'default' },
          };
        return { ok: true, data: snapshot };
      },
      disconnect: async (): Promise<ConnectionResult> => {
        logouts++;
        snapshot = { status: 'disconnected' };
        return { ok: true, data: snapshot };
      },
    },
  },
});
Object.defineProperty(window, 'assignmentTest', {
  value: {
    waiting: (): void => {
      snapshot = waiting;
      window.dispatchEvent(new Event('wiki-connection-changed'));
    },
    mode: (value: string): void => {
      mode = value;
    },
    release: (): void => release?.(),
    releaseInitial: (): void => releaseInitial?.(),
    counts: (): { mounts: number; refreshes: number; logouts: number } => ({
      mounts,
      refreshes,
      logouts,
    }),
  },
});
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
