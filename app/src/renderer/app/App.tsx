import { proposalExecutionGateway } from '@renderer/platform/proposalExecution';
import { RuntimeSetupPage } from '@renderer/pages/RuntimeSetupPage';
import type { JSX } from 'react';
import { QuestionRunPage } from '@renderer/pages/QuestionRunPage';
import { ResultDraftsPage } from '@renderer/pages/ResultDraftsPage';
import { AnalysisProposalsPage } from '@renderer/pages/AnalysisProposalsPage';
import { analysisProposalsGateway } from '@renderer/platform/analysisProposals';
import { Navigate, Route, Routes } from 'react-router';
import { HomePage } from '@renderer/pages/HomePage';
import { AppInfoPage } from '@renderer/pages/AppInfoPage';
import { ConnectionSetupPage } from '@renderer/pages/ConnectionSetupPage';
import { DocumentsPage } from '@renderer/pages/DocumentsPage';
import { AnalysisJobsPage } from '@renderer/pages/AnalysisJobsPage';
import { WorkspaceExplorerPage } from '@renderer/pages/WorkspaceExplorerPage';
import { PersonalRecordsPage } from '@renderer/pages/PersonalRecordsPage';
import { CorrespondencesPage } from '@renderer/pages/CorrespondencesPage';
import { AnalysisPlanPage } from '@renderer/pages/AnalysisPlanPage';
import { AppShell } from './AppShell';
import { useAppInfo } from './useAppInfo';

/** 앱의 경로와 공개 실행 정보를 조립하며 업무 데이터를 조회하지 않습니다. */
export function App(): JSX.Element {
  const { info, error } = useAppInfo();
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/setup/runtime" element={<RuntimeSetupPage />} />
        <Route path="/setup/connection" element={<ConnectionSetupPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/analysis" element={<AnalysisJobsPage />} />
        <Route path="/analysis-plan" element={<AnalysisPlanPage />} />
        <Route path="/result-drafts" element={<ResultDraftsPage />} />
        <Route
          path="/analysis-proposals"
          element={
            <AnalysisProposalsPage
              gateway={analysisProposalsGateway}
              executionGateway={proposalExecutionGateway}
            />
          }
        />
        <Route
          path="/work/:tenant/question-runs/:questionRunId?"
          element={<QuestionRunPage />}
        />
        <Route
          path="/knowledge"
          element={<WorkspaceExplorerPage mode="knowledge" />}
        />
        <Route
          path="/review"
          element={<WorkspaceExplorerPage mode="review" />}
        />
        <Route
          path="/history"
          element={<WorkspaceExplorerPage mode="history" />}
        />
        <Route
          path="/questions"
          element={<WorkspaceExplorerPage mode="questions" />}
        />
        <Route
          path="/conversations"
          element={<PersonalRecordsPage mode="conversations" />}
        />
        <Route
          path="/saved-results"
          element={<PersonalRecordsPage mode="savedResults" />}
        />
        <Route
          path="/comparisons"
          element={<PersonalRecordsPage mode="comparisons" />}
        />
        <Route path="/correspondences" element={<CorrespondencesPage />} />
        <Route
          path="/about"
          element={<AppInfoPage info={info} error={error} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
