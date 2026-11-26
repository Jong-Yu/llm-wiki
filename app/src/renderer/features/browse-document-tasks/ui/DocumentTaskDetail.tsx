import type { JSX, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { IconButton } from '@renderer/shared/ui/IconButton';
import buttonStyles from '@renderer/shared/ui/Button.module.scss';
import type {
  DocumentTaskAction,
  DocumentTaskStep,
  DocumentTaskStepState,
  DocumentTaskView,
} from '../model/documentTask.types';
import styles from './DocumentTasks.module.scss';

export type DocumentTaskDetailProps = {
  task: DocumentTaskView;
  busy?: boolean;
  error?: string | null;
  onAction: (action: DocumentTaskAction) => void;
  onBack?: () => void;
  historyPath?: string;
  currentViewPath?: string;
  executionContent?: ReactNode;
  textReviewPath?: string;
};
const stepLabels: Record<DocumentTaskStepState, string> = {
  complete: '완료',
  current: '진행 중',
  failed: '중단',
  waiting: '대기',
  ready: '대기',
  unconfirmed: '확인 필요',
  review: '내용 확인',
  stopped: '중단',
  unavailable: '기존 입력',
};

/** 결과 열람은 저장이나 재실행을 호출하지 않습니다. */
function documentPath(document: string): string {
  return `/document?${new URLSearchParams({ path: document })}`;
}

/** 현재 문서의 세 단계와 필요한 행동을 표시하며 읽기·복귀는 실행과 분리합니다. */
export function DocumentTaskDetail({
  task,
  busy = false,
  error = null,
  onAction,
  onBack,
  historyPath,
  currentViewPath,
  executionContent,
  textReviewPath,
}: DocumentTaskDetailProps): JSX.Element {
  const navigate = useNavigate();
  const resultReturnState = {
    workflowReturnTo: currentViewPath ?? task.detailPath,
  };
  const sourcePath = `/source?${new URLSearchParams({ sourceId: task.sourceId, version: task.sourceVersion })}`;
  const recordPath =
    historyPath ??
    (task.jobId
      ? `/jobs?${new URLSearchParams({ jobId: task.jobId, view: 'history' })}`
      : `/documents?${new URLSearchParams({ taskId: task.id, view: 'history' })}`);
  const result =
    task.results.find(
      (item: DocumentTaskView['results'][number]): boolean => item.current,
    ) ?? task.results[0];
  const action = task.primaryAction;
  const measure = task.measurement;
  const review = task.textReviewScopes.length > 0;
  return (
    <div
      className={`${styles.root} ${styles.detail}`}
      data-task-detail={task.id}
    >
      <div className={styles.progressHeader}>
        {onBack && (
          <IconButton icon="arrow-left" label="문서 목록" onClick={onBack} />
        )}
        <span data-completed-steps>{task.completionLabel}</span>
      </div>
      <header className={styles.progressTitle}>
        <h1>{task.title}</h1>
        <p className={styles.meta}>
          {task.fileName} ·{' '}
          <time dateTime={task.updatedAt}>
            {formatTimestamp(task.updatedAt)}
          </time>
        </p>
      </header>
      <ol className={styles.steps} aria-label="문서 등록 단계">
        {task.steps.map(
          (step: DocumentTaskStep, index: number): JSX.Element => (
            <li
              key={step.id}
              data-stage={step.id}
              data-state={step.state}
              aria-current={
                step.id === task.activeStep && task.state !== 'complete'
                  ? 'step'
                  : undefined
              }
            >
              <span className={styles.stepMark} aria-hidden="true">
                {step.state === 'complete' ? <Icon name="check" /> : index + 1}
              </span>
              <div>
                <h2>{step.title}</h2>
                <span>
                  {step.state === 'unavailable'
                    ? step.id === 'convert'
                      ? '기록 없음'
                      : step.id === 'wiki'
                        ? '기존 문서'
                        : '요청 없음'
                    : stepLabels[step.state]}
                </span>
              </div>
            </li>
          ),
        )}
      </ol>
      <section
        className={styles.progressFocus}
        aria-label="현재 작업"
        data-progress-focus
      >
        <h2 className={styles.focusTitle} aria-live="polite" aria-atomic="true">
          {task.status}
        </h2>
        <p
          className={styles.progressDescription}
          role={error ? 'alert' : undefined}
        >
          {error ?? task.explanation.body}
        </p>
        <div className={styles.progressMeasure} data-progress-measure>
          {measure ? (
            <>
              <div className={styles.progressQuantity}>
                <div>
                  <strong>{measure.completed.toLocaleString('ko-KR')}</strong>
                  <span className={styles.meta}>
                    {measure.total !== null
                      ? ` / ${measure.total.toLocaleString('ko-KR')}`
                      : ''}{' '}
                    {measure.unit}
                  </span>
                </div>
                {measure.percent !== null && <span>{measure.percent}%</span>}
              </div>
              {measure.total !== null && (
                <progress
                  className={styles.progressTrack}
                  max={measure.total}
                  value={measure.completed}
                  aria-label="문자 변환 처리량"
                />
              )}
              <div className={styles.measureCaption}>
                <span>문자 변환 처리 기록</span>
                <span>
                  {measure.remaining === null
                    ? '전체 수량 확인 전'
                    : `남은 ${measure.remaining.toLocaleString('ko-KR')} ${measure.unit}`}
                </span>
              </div>
            </>
          ) : (
            <div className={styles.progressOperation}>
              <strong>{task.operation.title}</strong>
              <span>{task.operation.note}</span>
            </div>
          )}
        </div>
        <div className={styles.progressAction}>
          <p>{task.explanation.next}</p>
          {review && action?.id !== 'refresh' ? (
            <Link
              className={`${buttonStyles.button} ${buttonStyles.primary}`}
              to={textReviewPath ?? sourcePath}
              state={resultReturnState}
            >
              등록할 내용 확인
            </Link>
          ) : action ? (
            <Button
              variant={action.id === 'stop-conversion' ? 'surface' : 'primary'}
              disabled={busy}
              onClick={(): void => onAction(action.id)}
            >
              {action.label}
            </Button>
          ) : null}
          {!review && textReviewPath && (
            <Link
              className={styles.textLink}
              to={textReviewPath}
              state={resultReturnState}
            >
              내용 직접 입력
            </Link>
          )}
        </div>
      </section>
      {executionContent}
      <footer className={styles.progressFooter}>
        <div className={styles.savedLink}>
          <Link
            className={styles.textLink}
            to={result ? documentPath(result.document) : sourcePath}
            state={resultReturnState}
          >
            <Icon name={result ? 'file-text' : 'files'} />
            {result ? '저장된 문서 열기' : '원본 보기'}
          </Link>
          {result && !result.current && (
            <small>이전 저장본 · 현재 판본 확인 필요</small>
          )}
        </div>
        <div className={styles.progressTools}>
          <IconButton
            icon="upload"
            label="파일 교체"
            onClick={(): void => {
              void navigate(
                `/register?${new URLSearchParams({ replaceSourceId: task.sourceId, version: task.sourceVersion })}`,
                { state: resultReturnState },
              );
            }}
            style={{
              visibility:
                (task.activeStep === 'convert' || task.inputLimited) &&
                !['running', 'complete'].includes(task.state)
                  ? 'visible'
                  : 'hidden',
            }}
            tabIndex={
              (task.activeStep === 'convert' || task.inputLimited) &&
              !['running', 'complete'].includes(task.state)
                ? undefined
                : -1
            }
            aria-hidden={
              (task.activeStep !== 'convert' && !task.inputLimited) ||
              ['running', 'complete'].includes(task.state)
            }
          />
          {action?.id !== 'refresh' && (
            <IconButton
              icon="refresh-cw"
              label="새로고침"
              disabled={busy}
              onClick={(): void => onAction('refresh')}
            />
          )}
          <IconButton
            icon="history"
            label="실행 기록"
            onClick={(): void => {
              void navigate(recordPath, { state: resultReturnState });
            }}
          />
        </div>
      </footer>
    </div>
  );
}

export type DocumentTaskDetailLoadingProps = {
  onBack?: () => void;
  error?: string | null;
  onRetry?: () => void;
};

/** 최초 조회도 같은 영역을 유지하며 로딩 표시를 실제 처리 단계로 오인하지 않게 합니다. */
export function DocumentTaskDetailLoading({
  onBack,
  error = null,
  onRetry,
}: DocumentTaskDetailLoadingProps): JSX.Element {
  return (
    <div className={`${styles.root} ${styles.detail}`} data-task-loading>
      <div className={styles.progressHeader}>
        {onBack && (
          <IconButton icon="arrow-left" label="문서 목록" onClick={onBack} />
        )}
        <span aria-hidden="true" className={styles.loadingText}>
          단계 확인 중
        </span>
      </div>
      <header className={styles.progressTitle}>
        <h1>등록 진행</h1>
        <p className={styles.meta}>문서 정보를 확인하고 있습니다.</p>
      </header>
      <ol
        className={styles.steps}
        aria-label="문서 등록 단계"
        aria-hidden="true"
      >
        {['문자 변환', 'Wiki 생성', '온톨로지 구성'].map(
          (title: string, index: number): JSX.Element => (
            <li key={title}>
              <span className={styles.stepMark}>{index + 1}</span>
              <div>
                <h2>{title}</h2>
                <span>확인 중</span>
              </div>
            </li>
          ),
        )}
      </ol>
      <section
        className={styles.progressFocus}
        aria-label="진행 정보 조회"
        data-progress-focus
      >
        <h2 className={styles.focusTitle} aria-live="polite" aria-atomic="true">
          {error
            ? '진행 정보를 확인하지 못했습니다'
            : '진행 정보를 읽고 있습니다'}
        </h2>
        <p
          className={styles.progressDescription}
          role={error ? 'alert' : undefined}
        >
          {error ?? '저장된 작업과 결과를 확인하고 있습니다.'}
        </p>
        <div
          className={styles.progressMeasure}
          data-progress-measure
          aria-hidden="true"
        >
          <div className={styles.loadingBlock} />
        </div>
        <div className={styles.progressAction}>
          <p>
            {error
              ? '다시 조회해도 문서 처리를 새로 실행하지 않습니다.'
              : '문서를 확인한 뒤 현재 단계와 가능한 행동을 표시합니다.'}
          </p>
          {error && onRetry && <Button onClick={onRetry}>다시 조회</Button>}
        </div>
      </section>
      <footer className={styles.progressFooter} aria-hidden="true">
        <span className={styles.loadingText}>저장 결과 확인 중</span>
      </footer>
    </div>
  );
}
