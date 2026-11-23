import { StrictMode, useEffect } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import type { Location } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { RetainedWorkspace } from '@renderer/app/RetainedWorkspace';
import { RegisterDocumentPage } from '@renderer/pages/register/RegisterDocumentPage';
import { DocumentTasksPage } from '@renderer/pages/tasks/DocumentTasksPage';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { installFixtureBridge } from './fixtures';

installFixtureBridge();

/** 이전 주소 직접 진입도 같은 실제 router로 전달하는 테스트 전용 제어기입니다. */
function FixtureNavigation(): null {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect((): void => {
    Reflect.set(window, '__documentTaskNavigate', (path: string): void => {
      void navigate(path);
    });
    Reflect.set(
      window,
      '__documentTaskLocation',
      `${location.pathname}${location.search}`,
    );
    const history: unknown = Reflect.get(
      window,
      '__documentTaskNavigationHistory',
    );
    const previous = Array.isArray(history)
      ? history.filter(
          (value: unknown): value is string => typeof value === 'string',
        )
      : [];
    Reflect.set(window, '__documentTaskNavigationHistory', [
      ...previous,
      `${location.pathname}${location.search}`,
    ]);
  }, [location, navigate]);
  return null;
}

/** 결과 목적지는 합성임을 표시하며 링크 주소와 읽기 이동만 검증합니다. */
function FixtureDestination(): JSX.Element {
  const location = useLocation();
  return (
    <WorkspacePage title="격리된 결과 목적지">
      <p data-fixture-destination>
        {location.pathname}
        {location.search}
      </p>
      <p>보존된 Wiki 원문 fixture · 저장 호출 없음</p>
      <Link to="/tasks">작업 목록</Link>
      <Link to="/register">문서 등록</Link>
    </WorkspacePage>
  );
}

/** 제품과 같은 보관 라우터에 실제 등록·작업 controller를 연결합니다. */
function renderRoutes(location: Location): JSX.Element {
  return (
    <Routes location={location}>
      <Route path="/register" element={<RegisterDocumentPage />} />
      <Route path="/tasks" element={<DocumentTasksPage />} />
      <Route path="*" element={<FixtureDestination />} />
    </Routes>
  );
}

const initialPath =
  new URLSearchParams(location.search).get('route') ?? '/register';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter initialEntries={[initialPath]}>
      <FixtureNavigation />
      <ReadQueriesProvider identity="isolated-document-workflow">
        <AppShell>
          <RetainedWorkspace render={renderRoutes} />
        </AppShell>
      </ReadQueriesProvider>
    </MemoryRouter>
  </StrictMode>,
);
