import { StrictMode } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, useLocation } from 'react-router';
import type { AiActivity, AccountUsage } from '@contracts/aiSessions.contract';
import { AppShell } from '@renderer/app/AppShell';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import {
  AiSessions,
  AccountUsagePanel,
} from '@renderer/features/browse-ai-sessions';
import { KnowledgeComparisons } from '@renderer/features/browse-ai-sessions/ui/KnowledgeComparisons';
import '@renderer/shared/theme/tokens.css';
import { comparisonBridge, comparisonChecks } from './comparisons.fixture';

const activities: AiActivity[] = [
  {
    kind: 'analysis',
    id: 'a'.repeat(32),
    connectionId: 'fixture',
    status: 'running',
    startedAt: '2026-10-29T13:00:00Z',
    document: 'sample.md',
  },
  {
    kind: 'question',
    id: 'b'.repeat(32),
    connectionId: 'fixture',
    status: 'running',
    startedAt: '2026-10-29T13:00:00Z',
    conversationId: 'c'.repeat(32),
  },
];
const usage: AccountUsage = {
  provider: 'codex',
  status: 'available',
  accountLabel: 'Fixture account',
  checkedAt: '2026-10-29T13:00:00Z',
  stale: false,
  windows: [
    {
      name: '5시간',
      usedPercent: 30,
      remainingPercent: 70,
      windowMinutes: 300,
      resetsAt: '2026-10-29T18:00:00Z',
    },
    {
      name: '주간',
      usedPercent: 20,
      remainingPercent: 80,
      windowMinutes: 10080,
      resetsAt: null,
    },
  ],
  message: null,
};
const checks = {
  activities,
  usage,
  comparisons: comparisonChecks,
  stopped: [] as string[],
  reads: 0,
  starts: 0,
  connected: true,
  hold: false,
  waiting: false,
  release: (): void => {},
};
Reflect.set(window, '__continuity', checks);
Object.defineProperty(window, 'wiki', {
  value: {
    knowledgeComparisons: comparisonBridge,
    connection: {
      getState: async (): Promise<unknown> => ({
        ok: true,
        data: checks.connected
          ? {
              status: 'connected',
              connectionId: 'fixture',
              userId: 'fixture-user',
              policyRevision: 'd'.repeat(64),
              selection: { tenant: 'fixture', profile: 'default' },
              workspaces: [
                {
                  id: 'fixture',
                  displayName: '테스트 공간',
                  permissions: ['read'],
                  profiles: [{ id: 'default' }],
                },
              ],
            }
          : { status: 'disconnected' },
      }),
    },
    aiSessions: {
      read: async (): Promise<unknown> => {
        checks.reads += 1;
        const data = structuredClone({
          activities: checks.activities,
          usage: checks.usage,
        });
        if (checks.hold) {
          checks.waiting = true;
          await new Promise<void>((done: () => void): void => {
            checks.release = done;
          });
          checks.waiting = false;
        }
        return { ok: true, data };
      },
    },
    analysis: {
      list: async (): Promise<unknown> => ({
        ok: true,
        data: {
          items: [],
          nextCursor: null,
          complete: true,
          truncated: false,
          skippedCount: 0,
          requiresRefresh: false,
        },
      }),
      stopLocal: async (request: { jobId: string }): Promise<unknown> => {
        checks.stopped.push(request.jobId);
        checks.activities = checks.activities.filter(
          (item: AiActivity): boolean => item.id !== request.jobId,
        );
        return { ok: true, data: {} };
      },
      execute: async (): Promise<unknown> => {
        checks.starts += 1;
        return {
          ok: false,
          error: { code: 'unexpected_start', message: '조회로 실행됨' },
        };
      },
    },
    questionRuns: {
      list: async (): Promise<unknown> => ({
        ok: true,
        data: { items: [], nextCursor: null, incomplete: false },
      }),
      start: async (): Promise<unknown> => {
        checks.starts += 1;
        return {
          ok: false,
          error: { code: 'unexpected_start', message: '조회로 실행됨' },
        };
      },
    },
  },
});

/** 실제 공통 프레임·목록·사용량 컴포넌트를 같은 화면에 렌더링합니다. */
function Fixture(): JSX.Element {
  const location = useLocation();
  return (
    <AppShell>
      <div data-test-route={location.pathname} style={{ padding: '24px' }}>
        {location.pathname === '/settings' ? (
          <AccountUsagePanel />
        ) : location.pathname === '/sessions' ? (
          <>
            <AiSessions
              filter={{ sourceId: null, sourceVersion: null, document: null }}
            />
            {/* 관련 지식 찾기 결과는 목록이 아니라 작업 상세에서 보여 주므로 구역만 함께 렌더링합니다. */}
            <KnowledgeComparisons jobId={null} documentPath={null} />
          </>
        ) : (
          <p>선택한 작업 상세: {location.search}</p>
        )}
      </div>
    </AppShell>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <ReadQueriesProvider identity="continuity-fixture">
      <HashRouter>
        <Fixture />
      </HashRouter>
    </ReadQueriesProvider>
  </StrictMode>,
);
