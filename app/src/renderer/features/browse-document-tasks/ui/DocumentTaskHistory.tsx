import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { conversionFailureExplanation } from '@renderer/shared/lib/sourceConversionFailure';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { IconButton } from '@renderer/shared/ui/IconButton';
import type {
  DocumentTaskAction,
  DocumentTaskAttemptView,
  DocumentTaskStep,
  DocumentTaskStepState,
  DocumentTaskView,
} from '../model/documentTask.types';
import buttonStyles from '@renderer/shared/ui/Button.module.scss';
import styles from './DocumentTaskHistory.module.scss';

export type DocumentTaskHistoryProps = {
  task: DocumentTaskView;
  progressPath: string;
  textReviewPath?: string;
  busy?: boolean;
  error?: string | null;
  onAction: (action: DocumentTaskAction) => void;
};

type AttemptStatus = { label: string; icon: IconName; tone: string };
const attemptStatuses: Readonly<Record<string, AttemptStatus>> = {
  running: { label: '진행 중', icon: 'loader-circle', tone: 'active' },
  cancelling: { label: '중단 중', icon: 'pause', tone: 'warning' },
  complete: { label: '완료', icon: 'circle-check', tone: 'success' },
  partial: { label: '일부 변환', icon: 'triangle-alert', tone: 'warning' },
  failed: { label: '실패', icon: 'circle-alert', tone: 'danger' },
  cancelled: { label: '중단', icon: 'pause', tone: 'warning' },
  report_unconfirmed: {
    label: '저장 확인 필요',
    icon: 'circle-help',
    tone: 'warning',
  },
  '문자 확인 필요': {
    label: '내용 확인 필요',
    icon: 'clipboard-check',
    tone: 'warning',
  },
};
const stepLabels: Record<DocumentTaskStepState, string> = {
  complete: '완료',
  current: '진행 중',
  failed: '중단',
  waiting: '대기',
  ready: '대기',
  unconfirmed: '확인 필요',
  review: '내용 확인 필요',
  stopped: '중단',
  unavailable: '기록 없음',
};

/** 진단 근거가 있으면 설명하고 실패한 구체적 원인이 없으면 미확인을 명시합니다. */
function attemptMessage(attempt: DocumentTaskAttemptView): string {
  const known = conversionFailureExplanation(attempt.codes);
  if (known) return known.body;
  if (attempt.state === 'failed')
    return '문자 변환이 중단됐습니다. 이 기록에서는 구체적인 중단 원인을 확인하지 못했습니다.';
  return attempt.message || '상세 설명이 기록되지 않았습니다.';
}

/** 보존된 변환 시도, 현재 단계와 명시 행동을 나누어 보여 줍니다. 기록 열람은 실행하지 않습니다. */
export function DocumentTaskHistory({
  task,
  progressPath,
  textReviewPath,
  busy = false,
  error = null,
  onAction,
}: DocumentTaskHistoryProps): JSX.Element {
  const navigate = useNavigate();
  const historyPath = `${progressPath}&view=history`;
  const sourcePath = `/source?${new URLSearchParams({ sourceId: task.sourceId, version: task.sourceVersion })}`;
  const returnState = { workflowReturnTo: historyPath };
  const result =
    task.results.find(
      (item: DocumentTaskView['results'][number]): boolean => item.current,
    ) ?? task.results[0];
  const action = task.primaryAction;
  const review = task.textReviewScopes.length > 0;
  const statusIcon: IconName =
    task.state === 'complete'
      ? 'circle-check'
      : task.state === 'running'
        ? 'loader-circle'
        : task.state === 'failed'
          ? 'circle-alert'
          : task.state === 'ready'
            ? 'clock'
            : 'triangle-alert';
  return (
    <section className={styles.root} aria-label="실행 기록" data-task-history>
      <header className={styles.header}>
        <div className={styles.title}>
          <h1>{task.title}</h1>
          <p>{task.fileName}</p>
        </div>
        <div className={styles.tools} role="group" aria-label="기록 탐색">
          <IconButton
            icon="refresh-cw"
            label="실행 기록 새로고침"
            disabled={busy}
            onClick={(): void => onAction('refresh')}
          />
          <IconButton
            icon="files"
            label="원본 보기"
            onClick={(): void => {
              void navigate(sourcePath, { state: returnState });
            }}
          />
          {result && (
            <IconButton
              icon="file-text"
              label="저장된 문서 열기"
              onClick={(): void => {
                void navigate(
                  `/document?${new URLSearchParams({ path: result.document })}`,
                  { state: returnState },
                );
              }}
            />
          )}
          {task.jobId && (
            <IconButton
              icon="history"
              label="AI 실행 기록"
              onClick={(): void => {
                void navigate(
                  `/jobs?${new URLSearchParams({ jobId: task.jobId ?? '', view: 'history' })}`,
                  { state: returnState },
                );
              }}
            />
          )}
          <IconButton
            icon="arrow-right"
            label="등록 진행 열기"
            onClick={(): void => {
              void navigate(progressPath);
            }}
          />
        </div>
      </header>
      <section className={styles.summary} aria-label="현재 상태">
        <div className={styles.statusLine}>
          <h2 className={styles.status} data-state={task.state}>
            <Icon name={statusIcon} />
            {task.status}
          </h2>
          <span className={styles.updated}>
            최근 갱신{' '}
            <time dateTime={task.updatedAt}>
              {formatTimestamp(task.updatedAt)}
            </time>
          </span>
        </div>
        <p className={styles.description}>{task.explanation.body}</p>
        {error && (
          <p className={styles.error} role="alert">
            {error} 표시된 기록은 마지막으로 확인한 내용입니다.
          </p>
        )}
        <ol className={styles.stages} aria-label="문서 등록 단계">
          {task.steps.map(
            (step: DocumentTaskStep, index: number): JSX.Element => (
              <li
                key={step.id}
                data-state={step.state}
                aria-current={
                  step.id === task.activeStep && task.state !== 'complete'
                    ? 'step'
                    : undefined
                }
              >
                <span className={styles.stepMark} aria-hidden="true">
                  {step.state === 'complete' ? (
                    <Icon name="check" />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <strong>{step.title}</strong>
                  <span>{stepLabels[step.state]}</span>
                </div>
              </li>
            ),
          )}
        </ol>
        <div className={styles.next}>
          <p>{task.explanation.next}</p>
          {review && action?.id !== 'refresh' ? (
            <Link
              className={`${buttonStyles.button} ${buttonStyles.primary}`}
              to={textReviewPath ?? sourcePath}
              state={returnState}
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
        </div>
      </section>
      <section className={styles.records} aria-label="문자 변환 이력">
        <div className={styles.sectionHeading}>
          <h2>문자 변환 이력</h2>
          <span>{task.attempts.length}회</span>
        </div>
        {task.attempts.length === 0 ? (
          <p className={styles.empty}>
            이 기기에 보관된 문자 변환 이력이 없습니다.
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">실행</th>
                <th scope="col">상태</th>
                <th scope="col">시작 시각</th>
                <th scope="col">처리 내용</th>
              </tr>
            </thead>
            <tbody>
              {task.attempts.map(
                (attempt: DocumentTaskAttemptView): JSX.Element => {
                  const status = attemptStatuses[attempt.state] ?? {
                    label: '상태 확인 필요',
                    icon: 'circle-help',
                    tone: 'warning',
                  };
                  return (
                    <tr key={attempt.id} data-attempt-row>
                      <th scope="row">{attempt.title}</th>
                      <td data-label="상태">
                        <span
                          className={styles.attemptStatus}
                          data-tone={status.tone}
                        >
                          <Icon name={status.icon} />
                          {status.label}
                        </span>
                      </td>
                      <td data-label="시작 시각">
                        {attempt.startedAt ? (
                          <time dateTime={attempt.startedAt}>
                            {formatTimestamp(attempt.startedAt)}
                          </time>
                        ) : (
                          '기록 없음'
                        )}
                      </td>
                      <td data-label="처리 내용">
                        <div>
                          <p>{attemptMessage(attempt)}</p>
                          {attempt.state === 'failed' &&
                            !conversionFailureExplanation(attempt.codes) &&
                            attempt.message && (
                              <p className={styles.recordMessage}>
                                기록된 메시지: {attempt.message}
                              </p>
                            )}
                          {attempt.codes.some((code: string): boolean =>
                            /^[a-zA-Z0-9_.-]+$/.test(code),
                          ) && (
                            <p className={styles.diagnostics}>
                              진단 코드:{' '}
                              {attempt.codes
                                .filter((code: string): boolean =>
                                  /^[a-zA-Z0-9_.-]+$/.test(code),
                                )
                                .join(' · ')}
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
