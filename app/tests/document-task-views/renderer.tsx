import { useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Link, useLocation, useSearchParams } from 'react-router';
import { analysisExecutionInspectionSchema } from '@contracts/analysis.contract';
import type {
  AnalysisDetailResult,
  AnalysisExecuteRequest,
  AnalysisExecutionInspectionResult,
  AnalysisReadRequest,
} from '@contracts/analysis.contract';
import {
  DocumentTaskDetail,
  DocumentTaskDetailLoading,
  DocumentTaskList,
  buildDocumentTaskView,
  buildAnalysisProgressView,
  documentTaskApi,
} from '@renderer/features/browse-document-tasks';
import type { DocumentTaskAction } from '@renderer/features/browse-document-tasks';
import { workflowReturnTo } from '@renderer/shared/lib/workflowNavigation';
import { WorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import type { ImportScope } from '@renderer/features/import-document-content';
import { RemoteDocumentProgress } from '@renderer/pages/documents/RemoteDocumentProgress';
import {
  fixtureAnalysis,
  fixtureCompleteAnalysis,
  fixtureTask,
} from './fixtures';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';

const failed = fixtureTask();
const uncertain = fixtureTask();
uncertain.taskId = '2'.repeat(32);
uncertain.item.title = '결과 확인 대상';
uncertain.registration.state = 'unconfirmed';
const partial = fixtureTask();
partial.taskId = '3'.repeat(32);
partial.item.title = '부분 저장 문서';
partial.registration.state = 'linked';
const detail = fixtureAnalysis(partial);
partial.registration.jobId = detail.job.job_id;
const tasks = [
  buildDocumentTaskView(failed),
  buildDocumentTaskView(uncertain),
  buildDocumentTaskView(partial, { analysis: detail }),
];
const converting = fixtureTask();
converting.taskId = '4'.repeat(32);
const conversion = converting.conversions[0];
if (!conversion) throw new Error('Conversion fixture missing');
conversion.state = 'running';
conversion.progress = { stage: 'convert', completed: 73, total: 170 };
const wiki = fixtureTask();
wiki.taskId = '5'.repeat(32);
const wikiDetail = fixtureAnalysis(wiki);
wikiDetail.receipts = [];
wikiDetail.local.status = 'running';
wiki.registration.jobId = wikiDetail.job.job_id;
const ontology = fixtureTask();
ontology.taskId = '6'.repeat(32);
const ontologyDetail = fixtureAnalysis(ontology);
ontologyDetail.local.status = 'running';
ontology.registration.jobId = ontologyDetail.job.job_id;
const completed = fixtureTask();
completed.taskId = '7'.repeat(32);
const completedDetail = fixtureCompleteAnalysis(completed);
completed.registration.jobId = completedDetail.job.job_id;
const longTitle = fixtureTask();
longTitle.taskId = '8'.repeat(32);
longTitle.item.title =
  '등록 문서의 긴 제목과 여러 조건이 함께 들어간 아키텍처 검토 자료 '.repeat(5);
const variants = [
  ...tasks,
  buildDocumentTaskView(converting),
  buildDocumentTaskView(wiki, { analysis: wikiDetail }),
  buildDocumentTaskView(ontology, { analysis: ontologyDetail }),
  buildDocumentTaskView(completed, { analysis: completedDetail }),
  buildDocumentTaskView(longTitle),
];
const remote = buildAnalysisProgressView(ontologyDetail);

const remoteScope: ImportScope = {
  connectionId: 'fixture-only',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: 'e'.repeat(64),
  canRegister: true,
  canPrepare: true,
  canExtract: true,
};
const remoteDetail = fixtureAnalysis(fixtureTask());
remoteDetail.job.registration = null;
const remoteComplete = fixtureCompleteAnalysis(fixtureTask());
remoteComplete.job.registration = null;
const inspectRequests: AnalysisReadRequest[] = [];
const executeRequests: AnalysisExecuteRequest[] = [];
let deferNextInspection = false;
let finishInspection:
  | ((result: AnalysisExecutionInspectionResult) => void)
  | null = null;

/** 실제 원격 페이지의 보호된 API 경계만 합성 응답으로 대체합니다. */
function inspectionResult(): AnalysisExecutionInspectionResult {
  return {
    ok: true,
    data: analysisExecutionInspectionSchema.parse({
      detail: executeRequests.length > 0 ? remoteComplete : remoteDetail,
      mode: executeRequests.length > 0 ? null : 'resume',
      blockers: [],
      checkedAt: '2026-11-25T03:00:00Z',
    }),
  };
}

documentTaskApi.inspectAnalysis = async (
  request: AnalysisReadRequest,
): Promise<AnalysisExecutionInspectionResult> => {
  inspectRequests.push(structuredClone(request));
  if (deferNextInspection) {
    deferNextInspection = false;
    return new Promise<AnalysisExecutionInspectionResult>(
      (resolve: (result: AnalysisExecutionInspectionResult) => void): void => {
        finishInspection = resolve;
      },
    );
  }
  return inspectionResult();
};
documentTaskApi.executeAnalysis = async (
  request: AnalysisExecuteRequest,
): Promise<AnalysisDetailResult> => {
  executeRequests.push(structuredClone(request));
  return { ok: true, data: structuredClone(remoteComplete) };
};

/** 지연 응답은 테스트가 명시적으로 전달하며 임의 지연 시간에 의존하지 않습니다. */
function resolveInspection(): void {
  const resolve = finishInspection;
  if (!resolve) throw new Error('Deferred inspection missing');
  finishInspection = null;
  resolve(inspectionResult());
}

const remoteChecks = {
  reset: (): void => {
    if (finishInspection) throw new Error('Unresolved inspection at reset');
    inspectRequests.length = 0;
    executeRequests.length = 0;
    deferNextInspection = false;
  },
  defer: (): void => {
    deferNextInspection = true;
  },
  resolve: resolveInspection,
  counts: (): {
    inspect: number;
    execute: number;
    pending: boolean;
    inspections: AnalysisReadRequest[];
    executions: AnalysisExecuteRequest[];
  } => ({
    inspect: inspectRequests.length,
    execute: executeRequests.length,
    pending: finishInspection !== null,
    inspections: structuredClone(inspectRequests),
    executions: structuredClone(executeRequests),
  }),
};
declare global {
  interface Window {
    __remoteProgressChecks: typeof remoteChecks;
  }
}
window.__remoteProgressChecks = remoteChecks;

/** 화면을 보관한 채 비활성화하여 실제 WorkspaceActivity 수명 경계를 검증합니다. */
function RemoteFixture(): JSX.Element {
  const [active, setActive] = useState(true);
  return (
    <section data-remote-active={active}>
      <button onClick={(): void => setActive(false)}>화면 비활성화</button>
      <button onClick={resolveInspection}>검사 응답 도착</button>
      <WorkspaceActivity active={active}>
        <RemoteDocumentProgress
          scope={remoteScope}
          jobId={remoteDetail.job.job_id}
        />
      </WorkspaceActivity>
    </section>
  );
}

/** 실제 제품 화면의 탐색과 명시 행동만 검증하며 I/O는 호출하지 않습니다. */
function Fixture(): JSX.Element {
  const [parameters] = useSearchParams();
  const location = useLocation();
  const [actions, setActions] = useState<DocumentTaskAction[]>([]);
  const task = parameters.has('jobId')
    ? remote
    : variants.find(
        (item: (typeof tasks)[number]): boolean =>
          item.id === parameters.get('taskId'),
      );
  const returnTo = workflowReturnTo(location.state) ?? '/documents';
  return (
    <main>
      <output data-action-count>{actions.length}</output>
      {parameters.has('remoteCheck') ? (
        <RemoteFixture key={parameters.get('remoteCheck')} />
      ) : parameters.has('loading') ? (
        <DocumentTaskDetailLoading
          backPath="/documents"
          error={
            parameters.has('error') ? '서버 응답을 확인하지 못했습니다.' : null
          }
          onRetry={(): void =>
            setActions(
              (previous: DocumentTaskAction[]): DocumentTaskAction[] => [
                ...previous,
                'refresh',
              ],
            )
          }
        />
      ) : location.pathname === '/source' ||
        location.pathname === '/document' ||
        location.pathname === '/ontology' ||
        location.pathname === '/jobs' ||
        parameters.get('view') === 'history' ? (
        <Link to={returnTo}>작업으로 돌아가기</Link>
      ) : task ? (
        <>
          <DocumentTaskDetail
            task={task}
            error={
              parameters.has('error')
                ? '서버 응답을 확인하지 못했습니다.'
                : null
            }
            backPath={returnTo}
            currentViewPath={`${location.pathname}${location.search}`}
            onAction={(action: DocumentTaskAction): void =>
              setActions(
                (previous: DocumentTaskAction[]): DocumentTaskAction[] => [
                  ...previous,
                  action,
                ],
              )
            }
          />
        </>
      ) : (
        <DocumentTaskList tasks={tasks} />
      )}
    </main>
  );
}

const root = document.getElementById('document-task-test');
if (!root) throw new Error('Fixture root missing');
createRoot(root).render(
  <HashRouter>
    <Fixture />
  </HashRouter>,
);
