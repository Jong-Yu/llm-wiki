import { StrictMode } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router';
import type { Location } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { RetainedWorkspace } from '@renderer/app/RetainedWorkspace';
import { DocumentTasksPage } from '@renderer/pages/tasks/DocumentTasksPage';
import { NotificationsPage } from '@renderer/pages/notifications/NotificationsPage';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { installNotifications } from './fixtures';

installNotifications();
/** 제품의 실제 목록·작업 controller를 합성 연결과 같은 앱 프레임에서 검사합니다. */
function renderRoutes(location: Location): JSX.Element {
  return (
    <Routes location={location}>
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route path="/tasks" element={<DocumentTasksPage />} />
      <Route path="*" element={<p>격리된 링크 목적지</p>} />
    </Routes>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ReadQueriesProvider identity="isolated-notifications">
        <AppShell>
          <RetainedWorkspace render={renderRoutes} />
        </AppShell>
      </ReadQueriesProvider>
    </HashRouter>
  </StrictMode>,
);
