import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { documentTaskPath } from '@renderer/shared/lib/workflowNavigation';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import buttonStyles from '@renderer/shared/ui/Button.module.scss';
import { documentTaskNeedsAttention } from '../model/documentTask.types';
import type {
  DocumentTaskAction,
  DocumentTaskAttemptView,
  DocumentTaskResult,
  DocumentTaskStep,
  DocumentTaskStepState,
  DocumentTaskView,
} from '../model/documentTask.types';
import styles from './DocumentTasks.module.scss';

type DocumentTaskDetailProps = {
  task: DocumentTaskView;
  busy?: boolean;
  error?: string | null;
  onAction: (action: DocumentTaskAction) => void;
  executionContent?: ReactNode;
};
const stepLabels: Record<DocumentTaskStepState, string> = {
  complete: '완료',
  current: '진행 중',
  failed: '중단',
  waiting: '진행 전',
  ready: '실행 전',
  unconfirmed: '확인 필요',
  stopped: '실행 중단',
};
const stepIcons: Record<DocumentTaskStepState, IconName> = {
  complete: 'circle-check',
  current: 'loader-circle',
  failed: 'circle-alert',
  waiting: 'clock',
  ready: 'clock',
  unconfirmed: 'triangle-alert',
  stopped: 'pause',
};

/** 결과 문서 링크는 저장을 재실행하지 않고 정확한 경로만 전달합니다. */
function documentPath(document: string): string {
  return `/document?${new URLSearchParams({ path: document })}`;
}

/** 원본 보관·변환·분석 결과를 같은 주소에서 확인하고 허용된 행동만 제공합니다. */
export function DocumentTaskDetail({
  task,
  busy = false,
  error = null,
  onAction,
  executionContent,
}: DocumentTaskDetailProps): JSX.Element {
  const resultReturnState = { workflowReturnTo: documentTaskPath(task.id) };
  const sourcePath = `/source?${new URLSearchParams({ sourceId: task.sourceId, version: task.sourceVersion })}`;
  const firstResult = task.results[0];
  const action = task.primaryAction;
  return (
    <div
      className={`${styles.root} ${styles.detail}`}
      data-task-detail={task.id}
      aria-busy={busy}
    >
      <HeaderActions>
        {action && (
          <Button
            variant={action.id === 'stop-conversion' ? 'surface' : 'primary'}
            disabled={busy}
            onClick={(): void => onAction(action.id)}
          >
            {action.label}
          </Button>
        )}
        {!action && task.state === 'complete' && firstResult && (
          <Link
            className={`${buttonStyles.button} ${buttonStyles.primary}`}
            to={documentPath(firstResult.document)}
            state={resultReturnState}
          >
            문서 열기 <Icon name="arrow-right" />
          </Link>
        )}
        {action?.id !== 'refresh' && (
          <Button
            variant="surface"
            disabled={busy}
            onClick={(): void => onAction('refresh')}
          >
            새로고침
          </Button>
        )}
      </HeaderActions>
      <div className={styles.summary}>
        <span className={styles.status} data-state={task.state} role="status">
          {task.status}
        </span>
        <span className={styles.meta}>
          {task.fileName}
          {task.attemptCount > 0 ? ` · 변환 ${task.attemptCount}회` : ''} ·{' '}
          <time dateTime={task.updatedAt}>
            {formatTimestamp(task.updatedAt)}
          </time>
        </span>
      </div>
      <ol className={styles.steps} aria-label="문서 처리 단계">
        {task.steps.map((step: DocumentTaskStep): JSX.Element => (
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
      {error && <StatusNotice tone="error">{error}</StatusNotice>}
      {documentTaskNeedsAttention(task) ? (
        <StatusNotice
          tone={task.state === 'failed' ? 'error' : 'warning'}
          title={task.explanation.title}
        >
          <p>{task.explanation.body}</p>
          <p>{task.explanation.next}</p>
        </StatusNotice>
      ) : (
        <section className={styles.explanation} aria-label="현재 작업 안내">
          <h2>{task.explanation.title}</h2>
          <p>{task.explanation.body}</p>
          <p className={styles.secondary}>{task.explanation.next}</p>
        </section>
      )}
      {executionContent}
      <WorkspaceSection title="보존된 결과">
        <dl className={styles.results}>
          <div>
            <dt>원본</dt>
            <dd>
              <Link to={sourcePath} state={resultReturnState}>
                {task.title} <Icon name="arrow-right" />
              </Link>
            </dd>
          </div>
          <div>
            <dt>Wiki 문서</dt>
            <dd>
              {task.results.length > 0 ? (
                <ul className={styles.resultList}>
                  {task.results.map(
                    (result: DocumentTaskResult): JSX.Element => (
                      <li key={result.document}>
                        <Link
                          to={documentPath(result.document)}
                          state={resultReturnState}
                        >
                          {result.title} <Icon name="arrow-right" />
                        </Link>
                        {!result.current && (
                          <span> · 저장 당시 결과 · 현재 판본 확인 필요</span>
                        )}
                      </li>
                    ),
                  )}
                </ul>
              ) : task.state === 'unconfirmed' ? (
                '저장 결과 확인 전'
              ) : (
                '저장 완료 전'
              )}
            </dd>
          </div>
          <div>
            <dt>관계</dt>
            <dd>
              {task.results.some(
                (result: DocumentTaskResult): boolean => result.ontology,
              ) ? (
                <ul className={styles.resultList}>
                  {task.results
                    .filter(
                      (result: DocumentTaskResult): boolean => result.ontology,
                    )
                    .map((result: DocumentTaskResult): JSX.Element => (
                      <li key={result.document}>
                        <Link
                          to={`/ontology?${new URLSearchParams({ path: result.document })}`}
                          state={resultReturnState}
                        >
                          {result.title}의 관계 확인 <Icon name="arrow-right" />
                        </Link>
                        <span>
                          {result.current
                            ? ' · 검토 전'
                            : ' · 현재 판본 확인 필요'}
                        </span>
                      </li>
                    ))}
                </ul>
              ) : task.state === 'unconfirmed' ? (
                '저장 결과 확인 전'
              ) : (
                '이번 작업의 추출 완료 전'
              )}
            </dd>
          </div>
        </dl>
        {task.hasPreviousResults && (
          <p className={styles.previous}>
            이전 성공 결과는 유지됩니다. 위 상태는 현재 시도를 나타냅니다.
          </p>
        )}
      </WorkspaceSection>
      {task.warnings.length > 0 && (
        <WorkspaceSection title="변환 시 확인할 내용">
          <ul className={styles.warningList}>
            {task.warnings.map(
              (warning: string, index: number): JSX.Element => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ),
            )}
          </ul>
        </WorkspaceSection>
      )}
      <details className={styles.record}>
        <summary>처리 기록 보기</summary>
        <dl className={styles.results}>
          <div>
            <dt>최근 변경</dt>
            <dd>{formatTimestamp(task.updatedAt)}</dd>
          </div>
          {task.progress && (
            <div>
              <dt>문자 변환</dt>
              <dd>{task.progress} · 전체 작업 완료율이 아닙니다.</dd>
            </div>
          )}
        </dl>
        {task.attempts.length > 0 && (
          <ol className={styles.attemptList}>
            {task.attempts.map(
              (attempt: DocumentTaskAttemptView): JSX.Element => (
                <li key={attempt.id}>
                  <strong>{attempt.title}</strong>
                  {attempt.startedAt && (
                    <time dateTime={attempt.startedAt}>
                      {formatTimestamp(attempt.startedAt)}
                    </time>
                  )}
                  <p>{attempt.message}</p>
                  <code>{attempt.state}</code>
                  {attempt.codes.length > 0 && (
                    <ul>
                      {attempt.codes.map(
                        (code: string, index: number): JSX.Element => (
                          <li key={`${index}:${code}`}>
                            <code>{code}</code>
                          </li>
                        ),
                      )}
                    </ul>
                  )}
                </li>
              ),
            )}
          </ol>
        )}
        <p className={styles.secondary}>
          이 기기에 기록된 처리 시도입니다. 다른 기기의 실행 기록은 AI 실행
          기록에서 확인할 수 있습니다.
        </p>
      </details>
      <nav className={styles.related} aria-label="작업 관련 화면">
        <Link to="/tasks">작업 목록</Link>
        <Link to="/documents">문서 목록</Link>
        <Link to="/register">다른 문서 등록</Link>
      </nav>
    </div>
  );
}
