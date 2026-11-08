import { StrictMode, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { AiSessions } from '../../src/renderer/features/browse-ai-sessions/ui/AiSessions';
import { WorkspaceActivity } from '../../src/renderer/shared/lib/workspaceActivity';
import '../../src/renderer/shared/theme/tokens.css';
import '../../src/renderer/shared/theme/controls.scss';
import { AppShell } from '../../src/renderer/app/AppShell';
import { ReadQueriesProvider } from '../../src/renderer/shared/lib/readQueries';
import {
  visualConnection,
  visualActivity,
  visualJob,
  visualComparisonList,
  visualComparisonDetail,
} from './visualFixtures';
const visual = new URLSearchParams(location.search).has('visual');

type Checks = {
  mode: 'ok' | 'forbidden' | 'network';
  hold: boolean;
  waiting: boolean;
  release: () => void;
};
const checks: Checks = {
  mode: 'ok',
  hold: false,
  waiting: false,
  release: (): void => {},
};
Reflect.set(window, '__sessionChecks', checks);
Object.defineProperty(window, 'wiki', {
  configurable: true,
  value: {
    connection: {
      getState: async (): Promise<unknown> =>
        visual
          ? visualConnection
          : {
              ok: true,
              data: {
                status: 'connected',
                connectionId: 'fixture',
                userId: 'fixture-user',
                policyRevision: 'e'.repeat(64),
                selection: { tenant: 'fixture', profile: 'default' },
                workspaces: [{ id: 'fixture', permissions: ['read'] }],
              },
            },
    },
    analysis: {
      list: async (request: { cursor: string | null }): Promise<unknown> => {
        if (visual)
          return {
            ok: true,
            data: {
              items: [
                visualJob(undefined, undefined, undefined, true).job,
                visualJob(
                  '설계/온도-센서-인터페이스.md',
                  '온도 센서 인터페이스',
                  '4'.repeat(32),
                ).job,
                visualJob(
                  '설계/운전-모드-전환.md',
                  '운전 모드 전환 검토',
                  '5'.repeat(32),
                ).job,
              ],
              nextCursor: null,
              complete: true,
              truncated: false,
              skippedCount: 0,
              requiresRefresh: false,
            },
          };
        if (checks.hold) {
          checks.waiting = true;
          await new Promise<void>((resolve: () => void): void => {
            checks.release = resolve;
          });
          checks.waiting = false;
        }
        if (checks.mode === 'forbidden')
          return {
            ok: false,
            error: {
              code: 'forbidden',
              status: 403,
              message: '접근 거부 검증',
            },
          };
        if (checks.mode === 'network')
          return {
            ok: false,
            error: { code: 'network_error', message: '네트워크 실패 검증' },
          };
        return {
          ok: true,
          data: {
            items: [
              {
                job_id: 'a'.repeat(32),
                registration: { title: '이전 분석 자료' },
                source_ref: {
                  source_id: 'b'.repeat(32),
                  source_version: 'c'.repeat(32),
                },
                targets: [{ document: 'fixture.md' }],
                result_summary: { status: 'complete' },
                state: 'claimed',
                reported_status: 'complete',
                lease_status: 'none',
              },
            ],
            nextCursor: request.cursor ? null : 'next',
            complete: !!request.cursor,
            truncated: false,
            skippedCount: 0,
            requiresRefresh: false,
          },
        };
      },
    },
    ...(visual
      ? {
          aiSessions: { read: async (): Promise<unknown> => visualActivity },
          knowledgeComparisons: {
            list: async (): Promise<unknown> => visualComparisonList,
            read: async (): Promise<unknown> => visualComparisonDetail,
          },
        }
      : {}),
    aiSessions: {
      read: async (): Promise<unknown> => ({
        ok: true,
        data: {
          activities: [],
          usage: {
            provider: 'codex',
            status: 'unavailable',
            accountLabel: null,
            checkedAt: null,
            stale: false,
            windows: [],
            message: null,
          },
        },
      }),
    },
    questionRuns: {
      list: async (): Promise<unknown> => ({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false },
      }),
    },
  },
});

/** 실제 목록을 보관/활성 전환해 숨겨진 자료의 수명도 검사합니다. */
function Fixture(): JSX.Element {
  const [active, setActive] = useState(true);
  if (visual)
    return (
      <MemoryRouter initialEntries={['/sessions']}>
        <AppShell>
          <AiSessions
            filter={{ sourceId: null, sourceVersion: null, document: null }}
            comparisonId={'f'.repeat(32)}
          />
        </AppShell>
      </MemoryRouter>
    );
  return (
    <MemoryRouter>
      <button type="button" onClick={(): void => setActive(!active)}>
        화면 전환
      </button>
      <WorkspaceActivity active={active}>
        <div
          hidden={!active}
          data-catalog="true"
          data-workspace-container
          style={{ containerName: 'workspace', containerType: 'inline-size' }}
        >
          {/* 저장된 작업 목록은 문서·원본에서 들어온 대상 기준으로만 보여 줍니다. */}
          <AiSessions
            filter={{
              sourceId: null,
              sourceVersion: null,
              document: 'fixture.md',
            }}
          />
        </div>
      </WorkspaceActivity>
    </MemoryRouter>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <ReadQueriesProvider identity="session-fixture">
      <Fixture />
    </ReadQueriesProvider>
  </StrictMode>,
);
