import { WorkspaceLogin } from '@renderer/features/configure-workspace-tools';
import type { JSX } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import type { Location } from 'react-router';
import { DocumentLibraryPage } from '@renderer/pages/documents/DocumentLibraryPage';
import { RegisterDocumentPage } from '@renderer/pages/register/RegisterDocumentPage';
import { DocumentDetailPage } from '@renderer/pages/document/DocumentDetailPage';
import { OntologyMapPage } from '@renderer/pages/ontology/OntologyMapPage';
import { KnowledgeChatPage } from '@renderer/pages/chat/KnowledgeChatPage';
import { ArtifactPreviewPage } from '@renderer/pages/artifact/ArtifactPreviewPage';
import { ConnectionSettingsPage } from '@renderer/pages/settings/ConnectionSettingsPage';
import { SourceDetailPage } from '@renderer/pages/source/SourceDetailPage';
import { AnalysisProposalPage } from '@renderer/pages/analysis/AnalysisProposalPage';
import { AiSessionsPage } from '@renderer/pages/sessions/AiSessionsPage';
import { SessionHistoryPage } from '@renderer/pages/sessions/SessionHistoryPage';
import { AnalysisJobPage } from '@renderer/pages/jobs/AnalysisJobPage';
import { ReviewQueuePage } from '@renderer/pages/review/ReviewQueuePage';
import { UserGuidePage } from '@renderer/pages/guide/UserGuidePage';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { AppShell } from './AppShell';
import { RetainedWorkspace } from './RetainedWorkspace';

/** 이전 화면 주소의 문서·대화 선택값을 유지하며 현재 주소로 연결합니다. */
function LegacyRouteRedirect(): JSX.Element {
  const { pathname, search, hash } = useLocation();
  return (
    <Navigate
      to={{
        pathname: pathname.slice('/renewal'.length) || '/documents',
        search,
        hash,
      }}
      replace
    />
  );
}

/** 문서 간 관계의 이전 주소는 선택 문서 또는 문서 목록으로 돌려보냅니다. */
function DocumentConnectionsRedirect(): JSX.Element {
  const { search, hash } = useLocation();
  const path = new URLSearchParams(search).get('path');
  return (
    <Navigate
      to={{ pathname: path ? '/document' : '/documents', search, hash }}
      replace
    />
  );
}

/** 없는 주소를 임의 문서로 대체하지 않고 현재 위치에서 복구 경로를 제공합니다. */
function MissingPage(): JSX.Element {
  return (
    <WorkspacePage title="이 화면을 찾을 수 없습니다" standalone>
      <p>주소가 올바른지 확인하거나 목록에서 대상을 다시 선택해 주세요.</p>
      <Link to="/documents">문서 목록으로</Link>
    </WorkspacePage>
  );
}

/** 비활성 화면은 마지막 주소를 그대로 받아 내부 대상과 초안을 유지합니다. */
function renderWorkspaceRoutes(location: Location): JSX.Element {
  return (
    <Routes location={location}>
      <Route path="/" element={<Navigate to="/documents" replace />} />
      <Route path="/renewal/*" element={<LegacyRouteRedirect />} />
      <Route path="/documents" element={<DocumentLibraryPage />} />
      <Route path="/register" element={<RegisterDocumentPage />} />
      <Route path="/document" element={<DocumentDetailPage />} />
      <Route path="/source" element={<SourceDetailPage />} />
      <Route path="/ontology" element={<OntologyMapPage />} />
      <Route path="/review" element={<ReviewQueuePage />} />
      <Route path="/connections" element={<DocumentConnectionsRedirect />} />
      <Route path="/chat" element={<KnowledgeChatPage />} />
      <Route path="/artifact" element={<ArtifactPreviewPage />} />
      <Route path="/analysis-proposals" element={<AnalysisProposalPage />} />
      <Route path="/sessions" element={<AiSessionsPage />} />
      <Route path="/sessions/history" element={<SessionHistoryPage />} />
      <Route path="/jobs" element={<AnalysisJobPage />} />
      <Route path="/settings" element={<ConnectionSettingsPage />} />
      <Route path="/guide" element={<UserGuidePage />} />
      <Route path="*" element={<MissingPage />} />
    </Routes>
  );
}

/** 인증 범위 안에서 상세·작업·세션 경로를 조립하고 이전 화면의 초안을 유지합니다. */
export function App(): JSX.Element {
  const location = useLocation();
  return (
    <WorkspaceLogin
      publicContent={
        location.pathname === '/guide' ? (
          <UserGuidePage standalone />
        ) : undefined
      }
    >
      <AppShell>
        <RetainedWorkspace render={renderWorkspaceRoutes} />
      </AppShell>
    </WorkspaceLogin>
  );
}
