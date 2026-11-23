import { useId } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { documentTaskPath } from '@renderer/shared/lib/workflowNavigation';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import buttonStyles from '@renderer/shared/ui/Button.module.scss';
import {
  documentTaskNeedsAttention,
  matchesDocumentTaskStatus,
} from '../model/documentTask.types';
import type {
  DocumentTaskStatusFilter,
  DocumentTaskView,
} from '../model/documentTask.types';
import styles from './DocumentTasks.module.scss';

type DocumentTaskListProps = {
  tasks: readonly DocumentTaskView[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
};
type TaskFilter = { id: DocumentTaskStatusFilter; label: string };
const filters: readonly TaskFilter[] = [
  { id: 'all', label: '전체' },
  { id: 'running', label: '진행 중' },
  { id: 'attention', label: '조치 필요' },
  { id: 'ready', label: '실행 전' },
  { id: 'complete', label: '완료' },
];

/** 상태는 색과 함께 아이콘·문구로 식별합니다. */
function taskIcon(task: DocumentTaskView): IconName {
  if (task.state === 'running') return 'loader-circle';
  if (task.state === 'complete') return 'circle-check';
  if (task.state === 'failed') return 'circle-alert';
  if (task.state === 'stopped') return 'pause';
  return documentTaskNeedsAttention(task) ? 'triangle-alert' : 'clock';
}

/** 이 기기에 연결된 문서 처리 작업을 열람과 재실행을 구분하여 찾습니다. */
export function DocumentTaskList({
  tasks,
  loading = false,
  error = null,
  onRefresh,
}: DocumentTaskListProps): JSX.Element {
  const [parameters, setParameters] = useSearchParams();
  const location = useLocation();
  const searchId = useId();
  const status =
    filters.find(
      (filter: TaskFilter): boolean => filter.id === parameters.get('status'),
    )?.id ?? 'all';
  const query = parameters.get('q') ?? '';
  const visible = tasks.filter(
    (task: DocumentTaskView): boolean =>
      matchesDocumentTaskStatus(task, status) &&
      `${task.title} ${task.fileName}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const returnState = {
    workflowReturnTo: `${location.pathname}${location.search}`,
  };

  /** 검색과 필터를 주소에 보존하여 같은 목록으로 돌아올 수 있게 합니다. */
  function updateFilter(key: string, value: string): void {
    const next = new URLSearchParams(parameters);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParameters(next, { replace: key === 'q' });
  }

  return (
    <div className={styles.root} aria-busy={loading}>
      <HeaderActions>
        {onRefresh && (
          <Button variant="surface" disabled={loading} onClick={onRefresh}>
            새로고침
          </Button>
        )}
        <Link
          className={`${buttonStyles.button} ${buttonStyles.primary}`}
          to="/register"
        >
          <Icon name="plus" />
          문서 등록
        </Link>
      </HeaderActions>
      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label="작업 상태">
          {filters.map((filter: TaskFilter): JSX.Element => (
            <Button
              key={filter.id}
              variant="surface"
              aria-pressed={status === filter.id}
              onClick={(): void => updateFilter('status', filter.id)}
            >
              {filter.label}{' '}
              <span className={styles.count}>
                {
                  tasks.filter((task: DocumentTaskView): boolean =>
                    matchesDocumentTaskStatus(task, filter.id),
                  ).length
                }
              </span>
            </Button>
          ))}
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
      <div className={styles.listIntro}>
        <p className={styles.listNote}>
          이 기기의 문서 처리 {visible.length}개
        </p>
        <Link to="/sessions">
          AI 실행 기록 <Icon name="arrow-right" />
        </Link>
      </div>
      {error && <StatusNotice tone="error">{error}</StatusNotice>}
      {loading && tasks.length === 0 && (
        <p role="status">작업 기록을 읽고 있습니다.</p>
      )}
      {visible.length > 0 && (
        <table className={styles.table}>
          <caption className={styles.srOnly}>문서 처리 작업 목록</caption>
          <thead>
            <tr>
              <th scope="col">문서</th>
              <th scope="col">현재 상태</th>
              <th scope="col">최근 변경</th>
              <th scope="col">
                <span className={styles.srOnly}>행동</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((task: DocumentTaskView): JSX.Element => (
              <tr key={task.id} data-task-id={task.id}>
                <td data-label="문서">
                  <Link
                    className={styles.taskTitle}
                    to={documentTaskPath(task.id)}
                    state={returnState}
                  >
                    {task.title}
                  </Link>
                  <small>
                    {task.fileName}
                    {task.attemptCount > 0
                      ? ` · 변환 ${task.attemptCount}회`
                      : ''}
                  </small>
                </td>
                <td data-label="현재 상태">
                  <span className={styles.status} data-state={task.state}>
                    <Icon name={taskIcon(task)} />
                    {task.status}
                  </span>
                  {task.progress && <small>{task.progress}</small>}
                  {task.hasPreviousResults && (
                    <small>이전 성공 결과 보존됨</small>
                  )}
                </td>
                <td data-label="최근 변경">
                  <time dateTime={task.updatedAt}>
                    {formatTimestamp(task.updatedAt)}
                  </time>
                </td>
                <td className={styles.rowActions}>
                  <Link
                    to={documentTaskPath(task.id)}
                    state={returnState}
                    aria-label={`${task.title} 작업 보기`}
                  >
                    작업 보기 <Icon name="arrow-right" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && !error && visible.length === 0 && (
        <p className={styles.empty}>
          {tasks.length === 0
            ? '아직 이 기기에 기록된 문서 처리 작업이 없습니다. 문서를 등록하면 이곳에서 진행과 결과를 확인할 수 있습니다.'
            : '조건에 맞는 작업이 없습니다. 다른 상태를 선택하거나 검색어를 바꿔 주세요.'}
        </p>
      )}
    </div>
  );
}
