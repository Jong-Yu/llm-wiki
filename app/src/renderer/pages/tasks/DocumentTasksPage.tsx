import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AnalysisDetail, AnalysisJob } from '@contracts/analysis.contract';
import { conversionNeedsPageApproval } from '@contracts/sourceConversion.contract';
import type {
  DocumentTask,
  DocumentTaskDetailResult,
} from '@contracts/documentTasks.contract';
import {
  DocumentTaskList,
  DocumentTaskDetail,
  buildDocumentTaskView,
} from '@renderer/features/browse-document-tasks';
import type {
  DocumentTaskAction,
  DocumentTaskView,
} from '@renderer/features/browse-document-tasks';
import { AnalysisJobWorkspace } from '@renderer/features/browse-ai-sessions';
import {
  importScopeKey,
  listSourceProcessingSessions,
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
import { useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { documentTaskPath } from '@renderer/shared/lib/workflowNavigation';
import { Button } from '@renderer/shared/ui/Button';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { documentTaskScope } from './documentTaskScope';
import {
  NotificationWorkflow,
  notificationWorkflowPath,
} from '@renderer/features/review-source-notifications';

type TaskListProps = { scope: ImportScope };
type TaskDetailProps = { scope: ImportScope; taskId: string };
type TaskData = Extract<DocumentTaskDetailResult, { ok: true }>['data'];

/** 원본 처리 기록과 서버 분석 목록을 한 번씩 읽고 현재 작업으로 연결합니다. */
function TaskList({ scope }: TaskListProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [tasks, setTasks] = useState<readonly DocumentTask[]>([]);
  const [jobs, setJobs] = useState<ReadonlyMap<string, AnalysisJob>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    const request = ++generation.current;
    try {
      const result = await documentTaskApi.list(documentTaskScope(scope));
      if (request !== generation.current) return;
      if (!result.ok) {
        setTasks([]);
        setJobs(new Map());
        throw new Error(result.error.message);
      }
      setTasks(result.data.items);
      const nextJobs = new Map<string, AnalysisJob>();
      let cursor: string | null = null;
      let incomplete = false;
      for (let page = 0; page < 20; page += 1) {
        const result = await documentTaskApi.listAnalyses({
          connectionId: scope.connectionId,
          sourceId: null,
          cursor,
        });
        if (request !== generation.current) return;
        if (!result.ok) {
          incomplete = true;
          break;
        }
        result.data.items.forEach((job: AnalysisJob): void => {
          nextJobs.set(job.job_id, job);
        });
        incomplete ||=
          result.data.truncated ||
          result.data.skippedCount > 0 ||
          result.data.requiresRefresh;
        cursor = result.data.nextCursor;
        if (!cursor) break;
      }
      if (request !== generation.current) return;
      setJobs(nextJobs);
      setError(
        incomplete || cursor
          ? '일부 분석 기록을 확인하지 못했습니다. 해당 작업을 열어 현재 상태를 확인해 주세요.'
          : result.data.cleanupWarningCount
            ? '작업 기록은 보존됐지만 임시 파일 정리 경고가 있습니다.'
            : null,
      );
    } catch (cause: unknown) {
      if (request === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '작업 목록을 읽지 못했습니다.',
        );
    } finally {
      if (request === generation.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [scope]);
  useEffect((): (() => void) => {
    if (active)
      queueMicrotask((): void => {
        void load();
      });
    const timer = active
      ? window.setInterval((): void => {
          void load();
        }, 7000)
      : null;
    return (): void => {
      generation.current += 1;
      pending.current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [active, load]);
  const sessions = listSourceProcessingSessions(scope);
  const views = tasks.map((task: DocumentTask): DocumentTaskView =>
    buildDocumentTaskView(task, {
      processing: sessions
        .find(
          (entry: (typeof sessions)[number]): boolean =>
            entry.session.getSnapshot().taskId === task.taskId,
        )
        ?.session.getSnapshot(),
      job: task.registration.jobId
        ? jobs.get(task.registration.jobId)
        : undefined,
    }),
  );
  return (
    <DocumentTaskList
      tasks={views}
      loading={loading}
      error={error}
      onRefresh={(): void => {
        void load();
      }}
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
function TaskDetail({ scope, taskId }: TaskDetailProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [data, setData] = useState<TaskData | null>(null);
  const [session, setSession] = useState<ImportProcessingSession | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisDetail | null>(null);
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
        }
        throw new Error(result.error.message);
      }
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
      <WorkspacePage title="문서 처리 작업">
        <p role={error ? 'alert' : 'status'}>
          {error ?? '작업을 확인하고 있습니다…'}
        </p>
        <Button
          disabled={busy}
          onClick={(): void => {
            void load();
          }}
        >
          다시 확인
        </Button>
        <Link to="/tasks">작업 목록</Link>
      </WorkspacePage>
    );
  const view = buildDocumentTaskView(data.task, {
    processing: snapshot,
    analysis: analysis ?? snapshot?.detail,
    conversion: snapshot?.conversion ?? data.conversion,
    readFailed: error !== null,
    canWrite: scope.canPrepare,
  });
  const currentConversion = snapshot?.conversion ?? data.conversion;
  const conversionReference = conversionNeedsPageApproval(
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
          ? notificationWorkflowPath(conversionReference.conversionId)
          : undefined
      }
      executionContent={
        view.jobId ? (
          <AnalysisJobWorkspace
            jobId={view.jobId}
            embedded
            workflowReturnTo={documentTaskPath(taskId)}
            onDetailChange={setAnalysis}
            allowExecution={
              scope.canPrepare && view.state !== 'unconfirmed' && error === null
            }
          />
        ) : undefined
      }
    />
  );
}

/** 작업 목록과 상세는 현재 접근 범위를 확인한 후에만 보호 기록을 표시합니다. */
export function DocumentTasksPage(): JSX.Element {
  const model = useImportScope();
  const [parameters] = useSearchParams();
  if (model.state.status !== 'ready')
    return (
      <WorkspacePage title="작업">
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
  const workflowId = parameters.get('workflowId');
  if (workflowId)
    return /^[a-f0-9]{32}$/.test(workflowId) ? (
      <NotificationWorkflow
        key={`${importScopeKey(scope)}:${workflowId}`}
        scope={scope}
        workflowId={workflowId}
      />
    ) : (
      <WorkspacePage title="작업">
        <p role="alert">작업 주소를 확인할 수 없습니다.</p>
        <Link to="/notifications">알림 목록</Link>
      </WorkspacePage>
    );
  const taskId = parameters.get('taskId');
  if (taskId && !/^[a-f0-9]{32}$/.test(taskId))
    return (
      <WorkspacePage title="작업">
        <p role="alert">작업 주소를 확인할 수 없습니다.</p>
        <Link to="/tasks">작업 목록</Link>
      </WorkspacePage>
    );
  return taskId ? (
    <TaskDetail
      key={`${importScopeKey(scope)}:${taskId}`}
      scope={scope}
      taskId={taskId}
    />
  ) : (
    <TaskList key={importScopeKey(scope)} scope={scope} />
  );
}
