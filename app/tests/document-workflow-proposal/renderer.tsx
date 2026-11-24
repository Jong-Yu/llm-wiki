import './environment';
import { useEffect, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Link, useLocation, useNavigate } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { DocumentLibrary } from '@renderer/features/browse-document-library/ui/DocumentLibrary';
import { AiSessions } from '@renderer/features/browse-ai-sessions/ui/AiSessions';
import { AnalysisJobWorkspace } from '@renderer/features/browse-ai-sessions/ui/AnalysisJobWorkspace';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import {
  useRouteTitle,
  sourceTitleKey,
  documentTitleKey,
} from '@renderer/shared/lib/routeTitle';
import { useThemePreference } from '@renderer/shared/theme/useThemePreference';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { TaskDetail, TaskList } from './TaskScreens';
import { BaselineProgress } from './BaselineProgress';
import { RegistrationPreview } from './RegistrationPreview';
import {
  applyPreviewAction,
  proposed,
  readTasks,
  registerPreview,
  resetPreview,
  usePreviewTasks,
} from './previewStore';
import { taskLabel, taskPath } from './model';
import type { PreviewTask, TaskAction } from './model';
import type { SourceFile } from '@contracts/sources.contract';
import { rememberComparison } from './previewStore';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import './preview.scss';

/** 같은 주소·문서 상태의 현재 화면과 제안 화면을 다시 로드해 비교합니다. */
function switchMode(after: boolean, path: string, search: string): void {
  rememberComparison();
  const url = new URL(location.href);
  url.searchParams.set('mode', after ? 'after' : 'before');
  const parameters = new URLSearchParams(search);
  const task = readTasks().find(
    (item: PreviewTask): boolean =>
      item.id === parameters.get('task') ||
      item.sourceId === parameters.get('sourceId') ||
      item.sourceId === parameters.get('jobId'),
  );
  if (after && path === '/sessions') url.hash = '/tasks';
  else if (!after && path === '/tasks')
    url.hash = task ? currentTaskPath(task) : '/sessions';
  else if (after && ['/register', '/jobs'].includes(path) && task)
    url.hash = taskPath(task);
  location.assign(url.href);
}

/** 현재 제품은 변환과 접수된 분석을 서로 다른 상세로 엽니다. */
function currentTaskPath(task: PreviewTask): string {
  return task.phase === 'conversion'
    ? `/register?sourceId=${task.sourceId}&version=${task.version}`
    : `/jobs?jobId=${task.sourceId}`;
}

/** 제품 외부 비교 도구이며 실제 앱 화면의 정보 위계와 분리합니다. */
function PreviewTools(): JSX.Element {
  const route = useLocation();
  const navigate = useNavigate();
  const tasks = usePreviewTasks();
  const { preference, setPreference } = useThemePreference();
  useEffect((): void => {
    if (preference === 'system') setPreference('light');
  }, [preference, setPreference]);
  return (
    <aside className="preview-tools" aria-label="시안 비교 도구">
      <strong>문서 처리 UX 시안</strong>
      <span>모의 자료 · 실제 실행 없음</span>
      <div className="preview-modes" role="group" aria-label="비교 화면">
        <button
          type="button"
          aria-pressed={!proposed}
          onClick={(): void => switchMode(false, route.pathname, route.search)}
        >
          현재 화면
        </button>
        <button
          type="button"
          aria-pressed={proposed}
          onClick={(): void => switchMode(true, route.pathname, route.search)}
        >
          개선안
        </button>
      </div>
      <label>
        사례{' '}
        <select
          aria-label="상태 사례"
          value=""
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const task = tasks.find(
              (item: PreviewTask): boolean => item.id === event.target.value,
            );
            if (task)
              void navigate(proposed ? taskPath(task) : currentTaskPath(task));
          }}
        >
          <option value="">상태 선택</option>
          {tasks.map((task: PreviewTask): JSX.Element => (
            <option key={task.id} value={task.id}>
              {taskLabel(task)}
            </option>
          ))}
        </select>
      </label>
      <label>
        테마{' '}
        <select
          aria-label="시안 테마"
          value={preference}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
            setPreference(event.target.value === 'dark' ? 'dark' : 'light')
          }
        >
          <option value="light">화이트</option>
          <option value="dark">다크</option>
        </select>
      </label>
      <button
        type="button"
        onClick={(): void => {
          resetPreview();
          void navigate(proposed ? '/tasks' : '/sessions');
        }}
      >
        시안 초기화
      </button>
    </aside>
  );
}

/** 상세 재진입은 조회만 수행하며 시안 실행도 명시 버튼에서만 바꿉니다. */
function Screens(): JSX.Element {
  const route = useLocation();
  const navigate = useNavigate();
  const tasks = usePreviewTasks();
  const parameters = new URLSearchParams(route.search);
  const task = tasks.find(
    (item: PreviewTask): boolean =>
      item.id === parameters.get('task') ||
      item.sourceId === parameters.get('sourceId') ||
      item.sourceId === parameters.get('jobId') ||
      (parameters.has('path') && item.savedWiki === parameters.get('path')),
  );
  const [notice, setNotice] = useState<{ task: string; text: string } | null>(
    null,
  );
  useRouteTitle(`task:${task?.id ?? ''}`, task?.title ?? null);
  useRouteTitle(sourceTitleKey(task?.sourceId ?? ''), task?.title ?? null);
  useRouteTitle(documentTitleKey(task?.savedWiki ?? ''), task?.title ?? null);
  function onAction(id: string, action: TaskAction): void {
    setNotice({ task: id, text: applyPreviewAction(id, action) });
  }
  if (route.pathname === '/documents')
    return (
      <DocumentLibrary
        onOpenSource={(sourceId: string, version: string): void => {
          void navigate(
            `/source?${new URLSearchParams({ sourceId, version })}`,
            { state: { workflowReturnTo: '/documents' } },
          );
        }}
        onOpenDocument={(path: string): void => {
          void navigate(`/document?${new URLSearchParams({ path })}`);
        }}
        onOpenOntology={(path: string): void => {
          void navigate(`/ontology?${new URLSearchParams({ path })}`);
        }}
        analysisStarter={{
          inFlight: (): boolean => false,
          start: async (): Promise<{ ok: boolean; message: string }> => ({
            ok: false,
            message: '시안에서 실제 실행은 하지 않습니다.',
          }),
        }}
      />
    );
  if (route.pathname === '/sessions')
    return (
      <AiSessions
        filter={{ sourceId: null, sourceVersion: null, document: null }}
      />
    );
  if (route.pathname === '/tasks' && !parameters.has('task'))
    return <TaskList tasks={tasks} />;
  if (route.pathname === '/tasks' && task)
    return (
      <TaskDetail
        key={task.id}
        task={task}
        onAction={onAction}
        notice={notice?.task === task.id ? notice.text : null}
      />
    );
  if (route.pathname === '/register' && task)
    return <BaselineProgress task={task} />;
  if (route.pathname === '/jobs' && task)
    return <AnalysisJobWorkspace jobId={task.sourceId} />;
  if (route.pathname === '/register')
    return (
      <RegistrationPreview
        onRegistered={(title: string, file: SourceFile | null): void => {
          const created = registerPreview(title, file);
          void navigate(
            proposed ? taskPath(created) : currentTaskPath(created),
            { replace: true },
          );
        }}
      />
    );
  if (task && route.pathname === '/source')
    return (
      <section className="preview-detail">
        <HeaderActions>
          <Link
            to={proposed ? taskPath(task) : currentTaskPath(task)}
            state={{ workflowReturnTo: `${route.pathname}${route.search}` }}
          >
            작업 보기
          </Link>
        </HeaderActions>
        <WorkspaceSection title="등록 원본">
          <p>원본 상세는 복귀 동선을 확인하는 모의 화면입니다.</p>
          <dl className="preview-facts">
            <div>
              <dt>파일</dt>
              <dd>{task.fileName}</dd>
            </div>
            <div>
              <dt>보관 상태</dt>
              <dd>원본 보관 완료</dd>
            </div>
            <div>
              <dt>현재 작업</dt>
              <dd>{taskLabel(task)}</dd>
            </div>
          </dl>
        </WorkspaceSection>
        <WorkspaceSection title="생성된 문서">
          {task.savedWiki ? (
            <Link
              to={`/document?${new URLSearchParams({ path: task.savedWiki })}`}
              state={{ workflowReturnTo: `${route.pathname}${route.search}` }}
            >
              {task.savedWiki}
            </Link>
          ) : (
            <p>
              {task.state === 'unconfirmed'
                ? '저장 결과 확인 전입니다.'
                : '아직 저장된 Wiki 문서가 없습니다.'}
            </p>
          )}
        </WorkspaceSection>
      </section>
    );
  if (
    task &&
    (route.pathname === '/document' || route.pathname === '/ontology')
  )
    return (
      <section className="preview-detail">
        <HeaderActions>
          <Link to={proposed ? taskPath(task) : currentTaskPath(task)}>
            작업 보기
          </Link>
        </HeaderActions>
        <WorkspaceSection
          title={
            route.pathname === '/ontology'
              ? '추출 결과 · 검토 전'
              : '저장된 문서'
          }
        >
          <p>
            이 결과 영역은 보존된 결과로 돌아오는 동선을 확인하는 모의
            화면입니다.
          </p>
          <p>{task.savedWiki}</p>
          <Link
            to={`/source?sourceId=${task.sourceId}&version=${task.version}`}
            state={{ workflowReturnTo: taskPath(task) }}
          >
            등록 원본 보기
          </Link>
        </WorkspaceSection>
      </section>
    );
  return (
    <section className="preview-detail">
      <WorkspaceSection title="비교 시안의 범위">
        <p>
          작업 목록·문서 처리 상세·문서 목록의 상태 표시를 확인하는 시안입니다.
          이 메뉴의 기존 화면은 변경 대상에 포함하지 않았습니다.
        </p>
        <Link to={proposed ? '/tasks' : '/sessions'}>작업 목록으로</Link>
      </WorkspaceSection>
    </section>
  );
}

function Preview(): JSX.Element {
  const { preference } = useThemePreference();
  return (
    <div
      className="preview-root"
      data-wiki-theme={preference === 'dark' ? 'dark' : 'light'}
    >
      <PreviewTools />
      <div className="preview-frame">
        <AppShell>
          <Screens />
        </AppShell>
      </div>
    </div>
  );
}
if (!location.hash) location.hash = proposed ? '/tasks' : '/sessions';
const root = document.getElementById('workflow-preview');
if (!root) throw new Error('시안의 시작 요소가 없습니다.');
createRoot(root).render(
  <HashRouter>
    <ReadQueriesProvider
      identity={proposed ? 'workflow-after' : 'workflow-before'}
    >
      <Preview />
    </ReadQueriesProvider>
  </HashRouter>,
);
