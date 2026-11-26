import { StrictMode, useEffect } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { Location } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { RetainedWorkspace } from '@renderer/app/RetainedWorkspace';
import { ErrorReportPage } from '@renderer/pages/report/ErrorReportPage';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import type {
  VocSubmitRequest,
  VocSubmitResult,
} from '@contracts/voc.contract';
import { visualConnection } from '../ai-sessions/visualFixtures';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';

type FixtureMode = 'success' | 'failure' | 'pending' | 'throw';
type Checks = {
  mode: FixtureMode;
  calls: VocSubmitRequest[];
  finish: ((result: VocSubmitResult) => void) | null;
};
const checks: Checks = {
  mode: 'success',
  calls: [],
  finish: null,
};
Reflect.set(window, '__vocChecks', checks);

/** 서버 쓰기를 하지 않고 사용자가 제출한 원문과 응답 수명만 검증합니다. */
function receipt(): VocSubmitResult {
  return {
    ok: true,
    data: { report_id: 'a'.repeat(32), created_at: '2026-11-26T00:00:00Z' },
  };
}

Object.defineProperty(window, 'wiki', {
  configurable: true,
  value: {
    connection: { getState: async (): Promise<unknown> => visualConnection },
    runtime: {
      execute: async (): Promise<unknown> => ({
        ok: false,
        error: {
          code: 'fixture',
          message: '실제 AI를 사용하지 않는 검증입니다.',
        },
      }),
    },
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
    voc: {
      submit: async (request: VocSubmitRequest): Promise<VocSubmitResult> => {
        checks.calls.push(structuredClone(request));
        if (checks.mode === 'throw')
          throw new Error('fixture transport failure');
        if (checks.mode === 'failure')
          return {
            ok: false,
            error: {
              code: 'server_error',
              message: '오류 보고를 저장하지 못했습니다. 다시 시도해 주세요.',
            },
          };
        if (checks.mode === 'pending')
          return new Promise<VocSubmitResult>(
            (resolve: (result: VocSubmitResult) => void): void => {
              checks.finish = resolve;
            },
          );
        return receipt();
      },
    },
  },
});

/** 실제 라우터가 이동한 주소를 테스트 제어기에 알립니다. */
function FixtureLocation(): null {
  const location = useLocation();
  useEffect((): void => {
    Reflect.set(window, '__vocLocation', location.pathname);
  }, [location]);
  return null;
}

/** 오류 보고 외 목적지는 입력 보존을 확인하기 위한 읽기 전용 자리입니다. */
function renderRoutes(location: Location): JSX.Element {
  return (
    <Routes location={location}>
      <Route path="/report" element={<ErrorReportPage />} />
      <Route
        path="*"
        element={
          <WorkspacePage title="격리된 문서 목록">
            <p>문서 목록 검증용 화면</p>
          </WorkspacePage>
        }
      />
    </Routes>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/report']}>
      <FixtureLocation />
      <ReadQueriesProvider identity="isolated-error-report">
        <AppShell>
          <RetainedWorkspace render={renderRoutes} />
        </AppShell>
      </ReadQueriesProvider>
    </MemoryRouter>
  </StrictMode>,
);
