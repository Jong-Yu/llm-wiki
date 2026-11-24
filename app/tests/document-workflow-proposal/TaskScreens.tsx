import { useId, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import buttonStyles from '@renderer/shared/ui/Button.module.scss';
import sessionStyles from '@renderer/features/browse-ai-sessions/ui/AiSessions.module.scss';
import { taskLabel, taskPath } from './model';
import type { PreviewTask, TaskAction } from './model';
import styles from './TaskScreens.module.scss';

type TaskListProps = { tasks: readonly PreviewTask[] };
type TaskDetailProps = {
  task: PreviewTask;
  onAction: (id: string, action: TaskAction) => void;
  notice: string | null;
};
type TaskActivityProps = { tasks: readonly PreviewTask[] };
type StatusFilter = 'all' | 'running' | 'attention' | 'ready' | 'complete';
type StepState =
  | 'complete'
  | 'current'
  | 'failed'
  | 'waiting'
  | 'ready'
  | 'unconfirmed'
  | 'stopped';
type TaskStep = { title: string; state: StepState; note: string };

const filters: readonly { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'running', label: '진행 중' },
  { id: 'attention', label: '조치 필요' },
  { id: 'ready', label: '실행 전' },
  { id: 'complete', label: '완료' },
];
const linkButton = `${buttonStyles.button} ${buttonStyles.surface}`;
const primaryLink = `${buttonStyles.button} ${buttonStyles.primary}`;

/** 열람 여부와 관계없이 실제로 해결이 필요한 상태를 분류합니다. */
function needsAttention(task: PreviewTask): boolean {
  return (
    task.state === 'failed' ||
    task.state === 'partial' ||
    task.state === 'unconfirmed'
  );
}

/** 상태 필터는 전체 작업을 숨기거나 해결 처리하지 않고 조회만 좁힙니다. */
function matchesStatus(task: PreviewTask, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return needsAttention(task);
  return task.state === filter;
}

/** 상태는 색뿐 아니라 아이콘과 같은 문구로 식별합니다. */
function taskIcon(task: PreviewTask): IconName {
  if (task.state === 'running') return 'loader-circle';
  if (task.state === 'complete') return 'circle-check';
  if (task.state === 'failed') return 'circle-alert';
  if (task.state === 'cancelled') return 'pause';
  if (needsAttention(task)) return 'triangle-alert';
  return 'clock';
}

/** 변환 단계의 실측 단위를 표시하며 전체 작업 완료율로 바꾸지 않습니다. */
function progressText(task: PreviewTask): string | null {
  if (task.phase !== 'conversion' || task.completedUnits === null) return null;
  return task.totalUnits === null
    ? `${task.completedUnits}쪽 처리 기록`
    : `${task.completedUnits} / ${task.totalUnits}쪽 처리 기록`;
}

/** 고정한 원본 판본을 여는 주소를 구성합니다. */
function sourcePath(task: PreviewTask): string {
  return `/source?${new URLSearchParams({ sourceId: task.sourceId, version: task.version })}`;
}

/** 보존된 Wiki 결과로 이동하며 새 실행을 만들지 않습니다. */
function wikiPath(task: PreviewTask): string {
  return `/document?${new URLSearchParams({ path: task.savedWiki ?? '' })}`;
}

/** 기존 세션 목록의 작업 면과 공통 헤더·컨트롤로 전역 작업 조회를 구성합니다. */
export function TaskList({ tasks }: TaskListProps): JSX.Element {
  const [parameters, setParameters] = useSearchParams();
  const location = useLocation();
  const searchId = useId();
  const status =
    filters.find(
      (filter: { id: StatusFilter; label: string }): boolean =>
        filter.id === parameters.get('status'),
    )?.id ?? 'all';
  const query = parameters.get('q') ?? '';
  const visible = tasks.filter(
    (task: PreviewTask): boolean =>
      matchesStatus(task, status) &&
      `${task.title} ${task.fileName}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const returnState = {
    workflowReturnTo: `${location.pathname}${location.search}`,
  };

  /** 검색·상태 선택을 주소에 보존해 상세에서 돌아올 때 같은 목록을 엽니다. */
  function updateFilter(key: string, value: string): void {
    const next = new URLSearchParams(parameters);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParameters(next, { replace: key === 'q' });
  }

  return (
    <div className={`${sessionStyles.root} ${styles.root}`}>
      <HeaderActions>
        <Link className={primaryLink} to="/register">
          <Icon name="plus" />
          문서 등록
        </Link>
      </HeaderActions>
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label="작업 상태">
          {filters.map(
            (filter: { id: StatusFilter; label: string }): JSX.Element => (
              <Button
                key={filter.id}
                variant="surface"
                aria-pressed={status === filter.id}
                onClick={(): void => updateFilter('status', filter.id)}
              >
                {filter.label}{' '}
                <span className={styles.count}>
                  {
                    tasks.filter((task: PreviewTask): boolean =>
                      matchesStatus(task, filter.id),
                    ).length
                  }
                </span>
              </Button>
            ),
          )}
        </div>
        <div className={styles.search}>
          <label htmlFor={searchId}>문서 이름 검색</label>
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="문서 또는 파일 이름"
            onChange={(event: ChangeEvent<HTMLInputElement>): void =>
              updateFilter('q', event.target.value)
            }
          />
        </div>
      </div>
      <p className={styles.listNote}>
        문서 처리 {visible.length}개 · 원본 변환부터 추출 결과까지 같은 작업에서
        확인합니다.
      </p>
      <table className={styles.table}>
        <caption className={styles.srOnly}>문서 처리 작업 목록</caption>
        <thead>
          <tr>
            <th>문서</th>
            <th>현재 상태</th>
            <th>최근 변경</th>
            <th>
              <span className={styles.srOnly}>행동</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((task: PreviewTask): JSX.Element => (
            <tr key={task.id} data-task-id={task.id}>
              <td data-label="문서">
                <Link
                  className={styles.taskTitle}
                  to={taskPath(task)}
                  state={returnState}
                >
                  {task.title}
                </Link>
                <small>
                  {task.fileName} · {task.attempt}번째 시도
                </small>
              </td>
              <td data-label="현재 상태">
                <span className={styles.status} data-state={task.state}>
                  <Icon name={taskIcon(task)} />
                  {taskLabel(task)}
                </span>
                {progressText(task) && <small>{progressText(task)}</small>}
                {task.previousSuccess && <small>이전 성공 결과 보존됨</small>}
              </td>
              <td data-label="최근 변경">
                <time dateTime={task.updatedAt.replace(' ', 'T')}>
                  {task.updatedAt}
                </time>
              </td>
              <td className={styles.rowActions}>
                <Link
                  to={taskPath(task)}
                  state={returnState}
                  aria-label={`${task.title} 작업 보기`}
                >
                  작업 보기 <Icon name="arrow-right" />
                </Link>
                {task.savedWiki && (
                  <Link to={wikiPath(task)} state={returnState}>
                    문서 열기
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 && (
        <p className={styles.empty}>
          조건에 맞는 작업이 없습니다. 다른 상태를 선택하거나 검색어를 바꿔
          주세요.
        </p>
      )}
    </div>
  );
}

/** 현재 단계의 실패·미확정·중단을 다음 단계의 완료와 구별합니다. */
function activeStep(task: PreviewTask): StepState {
  if (task.state === 'unconfirmed') return 'unconfirmed';
  if (task.state === 'failed' || task.state === 'partial') return 'failed';
  if (task.state === 'cancelled') return 'stopped';
  if (task.state === 'ready') return 'ready';
  return task.state === 'complete' ? 'complete' : 'current';
}

/** 원본 접수 이후 네 단계의 완료 근거를 현재 상태와 결과에 맞춰 보여 줍니다. */
function taskSteps(task: PreviewTask): readonly TaskStep[] {
  const active = activeStep(task);
  return [
    { title: '원본 보관', state: 'complete', note: '등록한 원본 보관됨' },
    {
      title: '문자 변환',
      state: task.phase === 'conversion' ? active : 'complete',
      note:
        task.phase === 'conversion'
          ? (progressText(task) ?? '처리량 기록 없음')
          : '본문 읽기 완료',
    },
    {
      title: 'Wiki 저장',
      state: task.savedWiki
        ? 'complete'
        : task.phase === 'wiki'
          ? active
          : 'waiting',
      note: task.savedWiki
        ? '문서 보존됨'
        : task.phase === 'wiki' && task.state === 'unconfirmed'
          ? '저장 여부 확인 필요'
          : '아직 저장되지 않음',
    },
    {
      title: '관계 추출',
      state:
        task.state === 'complete'
          ? 'complete'
          : task.phase === 'ontology'
            ? active
            : 'waiting',
      note:
        task.state === 'complete'
          ? '추출 완료 · 검토 전'
          : task.phase === 'ontology'
            ? ontologySummary(task)
            : '앞 단계 완료 후 진행',
    },
  ];
}

const stepLabels: Record<StepState, string> = {
  complete: '완료',
  current: '진행 중',
  failed: '중단',
  waiting: '진행 전',
  ready: '실행 전',
  unconfirmed: '확인 필요',
  stopped: '실행 중단',
};
const stepIcons: Record<StepState, IconName> = {
  complete: 'circle-check',
  current: 'loader-circle',
  failed: 'circle-alert',
  waiting: 'clock',
  ready: 'clock',
  unconfirmed: 'triangle-alert',
  stopped: 'pause',
};

/** 관계 저장의 미확정·실행 중·미완료를 추출 전 상태와 구별합니다. */
function ontologySummary(task: PreviewTask): string {
  if (task.phase !== 'ontology') return '이번 시도 추출 전';
  if (task.state === 'unconfirmed') return '관계 저장 결과 확인 필요';
  if (task.state === 'running') return '이번 시도 추출 중';
  if (task.state === 'ready') return '실행 전';
  return '이번 시도 미완료';
}

/** 확인되지 않은 원인을 추측하지 않고 보존 결과와 다음 행동을 안내합니다. */
function taskExplanation(task: PreviewTask): {
  title: string;
  body: string;
  next: string;
} {
  if (task.state === 'failed')
    return {
      title: '문자 변환이 중단됐습니다',
      body: '구체적인 중단 원인이 기록되지 않았습니다. 등록한 원본과 읽은 부분의 기록은 보존되어 있습니다.',
      next: '원본을 다시 등록하지 않고 다시 변환할 수 있습니다. 재시도는 처음부터 변환하며, 읽지 못한 부분이 남아 있으면 관계 추출을 진행하지 않습니다.',
    };
  if (task.state === 'partial')
    return {
      title: '문서는 저장됐지만 관계 추출이 끝나지 않았습니다',
      body: '저장된 Wiki 문서는 바로 열 수 있습니다. 이번 시도의 관계 추출은 완료되지 않았습니다.',
      next: '실행 조건과 저장 결과를 확인한 뒤 미완료 단계를 실행합니다.',
    };
  if (task.state === 'unconfirmed')
    return {
      title: '저장 결과를 확인해야 합니다',
      body: '요청은 전달됐지만 저장 완료 여부를 확인하지 못했습니다. 실패나 미저장으로 판단하지 않습니다.',
      next: '같은 요청의 결과를 먼저 확인합니다. 확인 전에는 새 변환·저장 요청을 만들지 않습니다.',
    };
  if (task.state === 'ready')
    return {
      title: '분석을 실행하기 전입니다',
      body: '입력 준비가 완료되었습니다. 자동 실행 대기열에 등록된 상태는 아닙니다.',
      next: '실행 조건을 확인하고 실행을 선택하면 이 작업을 시작합니다.',
    };
  if (task.state === 'cancelled')
    return {
      title: '이 기기의 실행을 중단했습니다',
      body: '보관한 원본과 이미 저장된 결과는 유지됩니다. 서버 작업 취소와는 별개입니다.',
      next:
        task.phase === 'conversion'
          ? '다시 변환하면 원본부터 새로 읽습니다.'
          : '다시 실행하려면 실행 조건과 저장 결과를 먼저 확인합니다.',
    };
  if (task.state === 'complete')
    return {
      title: '문서와 추출 결과가 저장됐습니다',
      body: '추출한 관계는 검토 전 상태입니다. 추출 완료가 내용의 정확성이나 전문가 승인을 뜻하지 않습니다.',
      next: '저장된 문서와 관계를 열어 확인할 수 있습니다.',
    };
  return {
    title:
      task.phase === 'conversion'
        ? '원본에서 본문을 읽고 있습니다'
        : task.phase === 'wiki'
          ? 'Wiki 문서를 저장하고 있습니다'
          : '관계를 추출하고 있습니다',
    body: '다른 화면을 사용해도 작업 목록과 이 문서에서 같은 작업을 다시 열 수 있습니다.',
    next: '앱을 완전히 종료하면 이 기기의 실행이 중단될 수 있습니다.',
  };
}

/** 상태에 맞는 하나의 실행 행동만 선택합니다. 조회 링크는 이 경로를 사용하지 않습니다. */
function primaryAction(
  task: PreviewTask,
): { label: string; action: TaskAction } | null {
  if (
    task.state === 'failed' ||
    (task.state === 'cancelled' && task.phase === 'conversion')
  )
    return { label: '다시 변환', action: 'retry_conversion' };
  if (
    task.state === 'partial' ||
    task.state === 'ready' ||
    task.state === 'cancelled'
  )
    return { label: '실행 조건 확인', action: 'inspect_execution' };
  if (task.state === 'unconfirmed')
    return { label: '결과 확인', action: 'confirm_result' };
  if (task.state === 'running')
    return { label: '이 기기 실행 중단', action: 'stop' };
  return null;
}

/** 원본 보관부터 결과까지 한 위치에서 읽고 상태에 맞는 행동을 선택합니다. */
function TaskDetailContent({
  task,
  onAction,
  notice,
}: TaskDetailProps): JSX.Element {
  const [inspected, setInspected] = useState(false);
  const explanation = taskExplanation(task);
  const action = primaryAction(task);
  const steps = taskSteps(task);
  const canExecute = inspected && action?.action === 'inspect_execution';
  const resultReturnState = { workflowReturnTo: taskPath(task) };

  /** 조건 확인과 실제 실행을 서로 다른 명시 행동으로 유지합니다. */
  function act(): void {
    if (!action) return;
    if (canExecute) onAction(task.id, 'execute_remaining');
    else {
      onAction(task.id, action.action);
      if (action.action === 'inspect_execution') setInspected(true);
    }
  }

  return (
    <div
      className={`${sessionStyles.root} ${styles.root} ${styles.detail}`}
      data-task-detail={task.id}
    >
      <HeaderActions>
        {task.state === 'complete' && task.savedWiki && (
          <Link
            className={primaryLink}
            to={wikiPath(task)}
            state={resultReturnState}
          >
            문서 열기 <Icon name="arrow-right" />
          </Link>
        )}
        {action && (
          <Button
            variant={task.state === 'running' ? 'surface' : 'primary'}
            onClick={act}
          >
            {canExecute ? '미완료 단계 실행' : action.label}
          </Button>
        )}
      </HeaderActions>
      <div className={styles.summary}>
        <span className={styles.status} data-state={task.state}>
          <Icon name={taskIcon(task)} />
          {taskLabel(task)}
        </span>
        <span className={styles.meta}>
          {task.fileName} · {task.attempt}번째 시도 · {task.updatedAt}
        </span>
      </div>
      <ol className={styles.steps} aria-label="문서 처리 단계">
        {steps.map((step: TaskStep): JSX.Element => (
          <li key={step.title} data-state={step.state}>
            <Icon name={stepIcons[step.state]} />
            <div>
              <strong>{step.title}</strong>
              <span>{stepLabels[step.state]}</span>
              <small>{step.note}</small>
            </div>
          </li>
        ))}
      </ol>
      {notice && <StatusNotice tone="info">{notice}</StatusNotice>}
      {needsAttention(task) ? (
        <StatusNotice
          tone={task.state === 'failed' ? 'error' : 'warning'}
          title={explanation.title}
        >
          <p>{explanation.body}</p>
          <p>{explanation.next}</p>
        </StatusNotice>
      ) : (
        <div className={styles.explanation}>
          <h2>{explanation.title}</h2>
          <p>{explanation.body}</p>
          <p className={styles.secondary}>{explanation.next}</p>
        </div>
      )}
      <WorkspaceSection title="보존된 결과">
        <dl className={styles.results}>
          <div>
            <dt>원본</dt>
            <dd>
              <Link to={sourcePath(task)} state={resultReturnState}>
                {task.fileName} <Icon name="arrow-right" />
              </Link>
            </dd>
          </div>
          <div>
            <dt>Wiki 문서</dt>
            <dd>
              {task.savedWiki ? (
                <Link to={wikiPath(task)} state={resultReturnState}>
                  {task.title} <Icon name="arrow-right" />
                </Link>
              ) : task.state === 'unconfirmed' ? (
                '저장 결과 확인 전'
              ) : (
                '아직 저장되지 않음'
              )}
            </dd>
          </div>
          <div>
            <dt>관계</dt>
            <dd>
              {task.state === 'complete' && task.savedWiki ? (
                <Link
                  to={`/ontology?${new URLSearchParams({ path: task.savedWiki })}`}
                  state={resultReturnState}
                >
                  추출 관계 확인 · 검토 전 <Icon name="arrow-right" />
                </Link>
              ) : (
                ontologySummary(task)
              )}
            </dd>
          </div>
        </dl>
        {task.previousSuccess && (
          <p className={styles.previous}>
            이전 성공: {task.previousSuccess}. 이전 결과는 유지되며 위 상태는
            최신 시도를 나타냅니다.
          </p>
        )}
      </WorkspaceSection>
      <details className={styles.record}>
        <summary>처리 기록 보기</summary>
        <dl className={styles.results}>
          <div>
            <dt>최근 변경</dt>
            <dd>{task.updatedAt}</dd>
          </div>
          <div>
            <dt>시도</dt>
            <dd>{task.attempt}번째</dd>
          </div>
          {progressText(task) && (
            <div>
              <dt>문자 변환</dt>
              <dd>{progressText(task)} · 전체 작업 완료율이 아닙니다.</dd>
            </div>
          )}
          {task.errorCode && (
            <div>
              <dt>오류 코드</dt>
              <dd>
                <code>{task.errorCode}</code>
              </dd>
            </div>
          )}
        </dl>
      </details>
      <nav className={styles.related} aria-label="작업 관련 화면">
        <Link className={linkButton} to="/tasks">
          작업 목록
        </Link>
        <Link className={linkButton} to="/documents">
          문서 목록
        </Link>
        <Link className={linkButton} to="/register">
          다른 문서 등록
        </Link>
      </nav>
    </div>
  );
}

/** 대상·판본·상태가 바뀌면 이전 실행 조건 확인을 새 작업에 넘기지 않습니다. */
export function TaskDetail(props: TaskDetailProps): JSX.Element {
  const { task } = props;
  return (
    <TaskDetailContent
      key={`${task.id}:${task.sourceId}:${task.version}:${task.state}`}
      {...props}
    />
  );
}

/** 전역 상태 표시에서 진행·조치 필요 필터와 동일 작업 목록으로 연결합니다. */
export function TaskActivity({ tasks }: TaskActivityProps): JSX.Element {
  const running = tasks.filter(
    (task: PreviewTask): boolean => task.state === 'running',
  ).length;
  const attention = tasks.filter(needsAttention).length;
  return (
    <div className={styles.activity} aria-label="작업 현황">
      <Link to="/tasks">작업</Link>
      <span aria-hidden="true">·</span>
      <Link to="/tasks?status=running">진행 {running}</Link>
      <span aria-hidden="true">·</span>
      <Link
        to="/tasks?status=attention"
        className={attention > 0 ? styles.attention : undefined}
      >
        조치 필요 {attention}
      </Link>
    </div>
  );
}
