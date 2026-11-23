import { useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Link, useLocation, useSearchParams } from 'react-router';
import {
  DocumentTaskDetail,
  DocumentTaskList,
  buildDocumentTaskView,
} from '@renderer/features/browse-document-tasks';
import type { DocumentTaskAction } from '@renderer/features/browse-document-tasks';
import { workflowReturnTo } from '@renderer/shared/lib/workflowNavigation';
import { fixtureAnalysis, fixtureTask } from './fixtures';
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

/** 실제 제품 화면의 탐색과 명시 행동만 검증하며 I/O는 호출하지 않습니다. */
function Fixture(): JSX.Element {
  const [parameters] = useSearchParams();
  const location = useLocation();
  const [actions, setActions] = useState<DocumentTaskAction[]>([]);
  const task = tasks.find(
    (item: (typeof tasks)[number]): boolean =>
      item.id === parameters.get('taskId'),
  );
  const returnTo = workflowReturnTo(location.state) ?? '/tasks';
  return (
    <main>
      <output data-action-count>{actions.length}</output>
      {location.pathname === '/source' ||
      location.pathname === '/document' ||
      location.pathname === '/ontology' ? (
        <Link to={returnTo}>작업으로 돌아가기</Link>
      ) : task ? (
        <>
          <Link to={returnTo}>목록으로 돌아가기</Link>
          <DocumentTaskDetail
            task={task}
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
