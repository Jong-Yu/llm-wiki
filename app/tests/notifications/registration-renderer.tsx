import { StrictMode } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router';
import type { Location } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { RetainedWorkspace } from '@renderer/app/RetainedWorkspace';
import { NotificationsPage } from '@renderer/pages/notifications/NotificationsPage';
import { NotificationWorkflow } from '@renderer/features/review-source-notifications';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { installNotifications, workflowId } from './fixtures';
import { fixtureRevision } from '../document-tasks/fixtures';

installNotifications();
const scope = {
  connectionId: 'fixture',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: fixtureRevision,
  canPrepare: true,
};
/** 새 작업면을 실제 앱 프레임과 합성 bridge로 검증하고 운영 데이터는 사용하지 않습니다. */
function renderRoutes(location: Location): JSX.Element {
  return (
    <Routes location={location}>
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route
        path="/documents"
        element={
          <NotificationWorkflow
            scope={{ ...scope }}
            workflowId={workflowId}
            backPath="/library"
            initialTargetDocument={
              new URLSearchParams(location.search).get('initialTarget') ??
              undefined
            }
          />
        }
      />
      <Route path="*" element={<p>격리된 문서 목록</p>} />
    </Routes>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ReadQueriesProvider identity="isolated-registration-content">
        <AppShell>
          <RetainedWorkspace render={renderRoutes} />
        </AppShell>
      </ReadQueriesProvider>
    </HashRouter>
  </StrictMode>,
);
