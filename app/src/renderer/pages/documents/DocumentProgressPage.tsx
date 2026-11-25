import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import { conversionNeedsContentReview } from '@contracts/sourceConversion.contract';
import type { DocumentTaskDetailResult } from '@contracts/documentTasks.contract';
import {
  DocumentTaskDetail,
  DocumentTaskDetailLoading,
  buildDocumentTaskView,
} from '@renderer/features/browse-document-tasks';
import type { DocumentTaskAction } from '@renderer/features/browse-document-tasks';
import {
  importScopeKey,
  restoreProcessingSession,
  useImportScope,
} from '@renderer/features/import-document-content';
import type {
  ImportScope,
  ImportProcessingSession,
  ImportProcessingSnapshot,
} from '@renderer/features/import-document-content';
import { documentTaskApi } from '@renderer/features/browse-document-tasks';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  ReadQueryError,
  invalidatesReadScope,
} from '@renderer/shared/lib/readQueries';
import { useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { documentTaskPath } from '@renderer/shared/lib/workflowNavigation';
import { RemoteDocumentProgress } from './RemoteDocumentProgress';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { documentTaskScope } from '../tasks/documentTaskScope';
import {
  NotificationWorkflow,
  notificationWorkflowPath,
} from '@renderer/features/review-source-notifications';

type TaskDetailProps = { scope: ImportScope; taskId: string; history: boolean };
type TaskData = Extract<DocumentTaskDetailResult, { ok: true }>['data'];
type ContentReviewProps = {
  scope: ImportScope;
  workflowId: string;
  returnTask: string | null;
  onContinued: (jobId: string) => void;
};

/** 등록 때 정한 저장 대상을 같은 변환 보고일 때만 내용 확인 화면에 전달합니다. */
function ContentReview({
  scope,
  workflowId,
  returnTask,
  onContinued,
}: ContentReviewProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  useEffect((): (() => void) => {
    let current = true;
    if (!returnTask) {
      queueMicrotask((): void => {
        if (current) setTarget(null);
      });
    } else if (active)
      void documentTaskApi
        .read({ ...documentTaskScope(scope), taskId: returnTask })
        .then((result: DocumentTaskDetailResult): void => {
          if (current)
            setTarget(
              result.ok &&
                result.data.conversion?.reference?.conversionId === workflowId
                ? result.data.task.targetDocument
                : null,
            );
        })
        .catch((): void => {
          if (current) setTarget(null);
        });
    return (): void => {
      current = false;
    };
  }, [scope, workflowId, returnTask, active]);
  if (target === undefined) return <DocumentTaskDetailLoading />;
  return (
    <NotificationWorkflow
      scope={scope}
      workflowId={workflowId}
      initialTargetDocument={target ?? undefined}
      backPath={returnTask ? documentTaskPath(returnTask) : '/documents'}
      onContinued={onContinued}
    />
  );
}

/** 세션이 없을 때도 hook 순서를 유지하며 읽기만 대기합니다. */
function emptySubscribe(_listener: () => void): () => void {
  return (): void => undefined;
}
function emptySnapshot(): null {
  return null;
}

/** 주소의 작업만 복원하고 명시 행동과 조회의 수명을 분리합니다. */
function TaskDetail({ scope, taskId, history }: TaskDetailProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [data, setData] = useState<TaskData | null>(null);
  const [session, setSession] = useState<ImportProcessingSession | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisDetail | null>(null);
  const [reviewedJob, setReviewedJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const snapshot: ImportProcessingSnapshot | null = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? emptySnapshot,
  );
  const load = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    const request = ++generation.current;
    pending.current = true;
    setBusy(true);
    try {
      const result = await documentTaskApi.read({
        ...documentTaskScope(scope),
        taskId,
      });
      if (request !== generation.current) return;
      if (!result.ok) {
        if (
          result.error.status === 401 ||
          result.error.status === 403 ||
          [
            'scope_changed',
            'connection_changed',
            'access_changed',
            'subject_changed',
          ].includes(result.error.code)
        ) {
          setData(null);
          setSession(null);
          setAnalysis(null);
          setReviewedJob(null);
        }
        throw new Error(result.error.message);
      }
      const reference = result.data.conversion?.reference;
      const linked =
        !result.data.task.registration.jobId &&
        reference &&
        conversionNeedsContentReview(result.data.conversion?.report)
          ? await documentTaskApi.findReviewedAnalysis(
              scope.connectionId,
              result.data.task,
              reference,
            )
          : null;
      if (request !== generation.current) return;
      setReviewedJob(linked?.job.job_id ?? null);
      setData(result.data);
      setAnalysis(result.data.analysis);
      setSession(restoreProcessingSession(scope, result.data));
      setError(
        result.data.errors
          .filter(
            (failure: TaskData['errors'][number]): boolean =>
              failure.code !== 'task_history_write_failed',
          )
          .map((failure: TaskData['errors'][number]): string => failure.message)
          .join(' · ') || null,
      );
    } catch (cause: unknown) {
      if (
        request === generation.current &&
        cause instanceof ReadQueryError &&
        invalidatesReadScope(cause.failure)
      ) {
        setData(null);
        setSession(null);
        setAnalysis(null);
        setReviewedJob(null);
      }
      if (request === generation.current)
        setError(
          cause instanceof Error ? cause.message : '작업을 읽지 못했습니다.',
        );
    } finally {
      if (request === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [scope, taskId]);
  useEffect((): (() => void) => {
    if (active)
      queueMicrotask((): void => {
        void load();
      });
    return (): void => {
      generation.current += 1;
      pending.current = false;
    };
  }, [active, load]);
  const running =
    snapshot?.busy ||
    ['converting', 'planning', 'running'].includes(snapshot?.phase ?? '') ||
    analysis?.local.status === 'running' ||
    analysis?.job.lease_status === 'active';
  useEffect((): (() => void) | undefined => {
    if (!active || !running) return undefined;
    const timer = window.setInterval((): void => {
      void load();
    }, 2000);
    return (): void => window.clearInterval(timer);
  }, [active, running, load]);
  useRouteTitle(`task:${taskId}`, data?.task.item.title ?? null);
  /** 읽기는 같은 영수증을 확인하고 재실행은 사용자 행동에서만 진입합니다. */
  function act(action: DocumentTaskAction): void {
    if (busy || snapshot?.busy) return;
    if (action === 'refresh') {
      void load();
      return;
    }
    if (!session || !scope.canPrepare) return;
    const operation =
      action === 'retry-conversion'
        ? session.retryConversion
        : action === 'stop-conversion'
          ? session.stopConversion
          : action === 'execute'
            ? session.execute
            : session.begin;
    void operation().then(load);
  }
  if (!data)
    return (
      <DocumentTaskDetailLoading
        error={error}
        onRetry={(): void => {
          void load();
        }}
      />
    );
  if (reviewedJob && !history)
    return <RemoteDocumentProgress scope={scope} jobId={reviewedJob} />;
  const view = buildDocumentTaskView(data.task, {
    processing: snapshot,
    analysis: analysis ?? snapshot?.detail,
    conversion: snapshot?.conversion ?? data.conversion,
    readFailed: error !== null,
    canWrite: scope.canPrepare,
  });
  if (history)
    return (
      <WorkspacePage title="실행 기록">
        <Link to={documentTaskPath(taskId)}>등록 진행으로 돌아가기</Link>
        <h2>{view.title}</h2>
        <ol>
          {view.attempts.map(
            (attempt: (typeof view.attempts)[number]): JSX.Element => (
              <li key={attempt.id}>
                <strong>{attempt.title}</strong>
                <p>
                  {attempt.startedAt
                    ? new Date(attempt.startedAt).toLocaleString('ko-KR')
                    : ''}{' '}
                  · {attempt.state}
                </p>
                <p>{attempt.message}</p>
              </li>
            ),
          )}
        </ol>
        {view.jobId && (
          <Link
            to={`/jobs?${new URLSearchParams({ jobId: view.jobId, view: 'history' })}`}
            state={{ workflowReturnTo: documentTaskPath(taskId) }}
          >
            AI 실행 기록
          </Link>
        )}
      </WorkspacePage>
    );
  const currentConversion = snapshot?.conversion ?? data.conversion;
  const conversionReference = conversionNeedsContentReview(
    currentConversion?.report,
  )
    ? currentConversion?.reference
    : null;
  return (
    <DocumentTaskDetail
      task={view}
      busy={busy || snapshot?.busy}
      error={error}
      onAction={act}
      textReviewPath={
        conversionReference
          ? `${notificationWorkflowPath(conversionReference.conversionId)}&returnTask=${encodeURIComponent(taskId)}`
          : undefined
      }
      historyPath={`/documents?${new URLSearchParams({ taskId, view: 'history' })}`}
    />
  );
}

/** 작업 목록과 상세는 현재 접근 범위를 확인한 후에만 보호 기록을 표시합니다. */
export function DocumentProgressPage(): JSX.Element {
  const model = useImportScope();
  const [parameters] = useSearchParams();
  const navigate = useNavigate();
  if (model.state.status !== 'ready')
    return (
      <WorkspacePage title="등록 진행">
        <p role={model.state.status === 'error' ? 'alert' : 'status'}>
          {model.state.status === 'error'
            ? model.state.message
            : model.state.status === 'loading'
              ? '작업 공간을 확인하고 있습니다…'
              : '작업 공간을 선택해 주세요.'}
        </p>
        <Link to="/settings">연결 설정</Link>
      </WorkspacePage>
    );
  const scope = model.state.scope;
  const jobId = parameters.get('jobId');
  if (jobId)
    return /^[a-f0-9]{32}$/.test(jobId) ? (
      <RemoteDocumentProgress
        key={`${importScopeKey(scope)}:${jobId}`}
        scope={scope}
        jobId={jobId}
      />
    ) : (
      <WorkspacePage title="등록 진행">
        <p role="alert">문서 진행 주소를 확인할 수 없습니다.</p>
        <Link to="/documents">문서 목록</Link>
      </WorkspacePage>
    );
  const workflowId = parameters.get('workflowId');
  if (workflowId)
    return /^[a-f0-9]{32}$/.test(workflowId) ? (
      <ContentReview
        key={`${importScopeKey(scope)}:${workflowId}`}
        scope={scope}
        workflowId={workflowId}
        returnTask={
          /^[a-f0-9]{32}$/.test(parameters.get('returnTask') ?? '')
            ? parameters.get('returnTask')
            : null
        }
        onContinued={(nextJobId: string): void => {
          void navigate(
            `/documents?${new URLSearchParams({ jobId: nextJobId })}`,
          );
        }}
      />
    ) : (
      <WorkspacePage title="등록 진행">
        <p role="alert">작업 주소를 확인할 수 없습니다.</p>
        <Link to="/documents">문서 목록</Link>
      </WorkspacePage>
    );
  const taskId = parameters.get('taskId');
  if (taskId && !/^[a-f0-9]{32}$/.test(taskId))
    return (
      <WorkspacePage title="등록 진행">
        <p role="alert">작업 주소를 확인할 수 없습니다.</p>
        <Link to="/documents">문서 목록</Link>
      </WorkspacePage>
    );
  return taskId ? (
    <TaskDetail
      key={`${importScopeKey(scope)}:${taskId}`}
      scope={scope}
      taskId={taskId}
      history={parameters.get('view') === 'history'}
    />
  ) : (
    <WorkspacePage title="등록 진행">
      <Link to="/documents">문서 목록</Link>
    </WorkspacePage>
  );
}
