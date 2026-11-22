import { Button } from '@renderer/shared/ui/Button';
import type { JSX } from 'react';
import type {
  RuntimeRequest,
  CliConnection,
  DiagnosticReport,
} from '@contracts/runtime.contract';
import type { AiConnectionLevel } from '@renderer/shared/lib/useAiConnection';
import {
  formatTimestamp,
  formatTimestampWithZone,
} from '@renderer/shared/lib/formatTimestamp';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { StatusNoticeProps } from '@renderer/shared/ui/StatusNotice';
import styles from './WorkspaceTools.module.scss';
import cardStyles from './AiStatusCard.module.scss';

type AiStatusCardProps = {
  level: AiConnectionLevel;
  providerName: string;
  connection?: CliConnection;
  busy: boolean;
  issue: boolean;
  onRequest: (request: RuntimeRequest) => Promise<void>;
  onChangePath: () => void;
  advancedId: string;
  /** Windows의 Claude 호출 실패에서만 진단 보고서 버튼을 보입니다. */
  canDiagnose: boolean;
  diagnosing: boolean;
  diagnosticReport?: DiagnosticReport;
};
const tones: Record<AiConnectionLevel, StatusNoticeProps['tone']> = {
  verified: 'success',
  login: 'info',
  required: 'warning',
  waiting: 'warning',
  checking: 'info',
  error: 'error',
  unknown: 'warning',
};

/** 오늘 확인한 호출은 시각만 짧게 보이고, 지난 호출은 날짜까지 보존합니다. */
function verifiedTimeLabel(value: string): string {
  const timestamp = formatTimestamp(value);
  return new Date(value).toDateString() === new Date().toDateString()
    ? `오늘 ${timestamp.slice(-5)}`
    : timestamp;
}

/** 연결 상태와 사유에 맞는 복구 동작을 제공합니다. */
export function AiStatusCard({
  level,
  providerName,
  connection,
  busy,
  issue,
  onRequest,
  onChangePath,
  advancedId,
  canDiagnose,
  diagnosing,
  diagnosticReport,
}: AiStatusCardProps): JSX.Element {
  const code = connection?.code;
  const callFailed = code?.startsWith('ai_') === true;
  const verifiedAt = connection?.verifiedAt;
  const title = {
    verified: '연결됨',
    login: '로그인은 확인됐어요',
    required: '연결이 필요해요',
    waiting: '로그인을 기다리고 있어요',
    checking: '확인하는 중이에요',
    error: callFailed ? '호출에 실패했어요' : '연결에 문제가 있어요',
    unknown: '상태 확인 필요',
  }[level];
  const description = {
    verified: (
      <>
        실제 호출로 응답을 확인했어요
        {verifiedAt && (
          <>
            {' '}
            ·{' '}
            <time
              dateTime={verifiedAt}
              title={formatTimestampWithZone(verifiedAt)}
            >
              {verifiedTimeLabel(verifiedAt)}
            </time>
          </>
        )}
      </>
    ),
    login: '아직 실제로 AI를 호출해 보지 않았어요',
    required: `${providerName}에 로그인하면 질문과 문서 분석을 쓸 수 있어요`,
    waiting: '터미널이나 브라우저에서 로그인을 마쳐 주세요',
    checking: `${providerName} 연결 상태를 확인하고 있어요`,
    error:
      connection?.message || `${providerName} 연결 상태를 확인하지 못했어요`,
    unknown: `확인된 연결 기록이 없어요. ${providerName}에 로그인하거나 로그인 상태를 확인해 주세요.`,
  }[level];

  /** 명시한 동작만 실행하며 저장 설정 오류가 있으면 로그인·호출을 제한합니다. */
  function button(
    label: string,
    request: RuntimeRequest,
    primary: boolean,
    blocked: boolean = false,
  ): JSX.Element {
    return (
      <Button
        variant={primary ? 'primary' : 'surface'}
        type="button"
        className={`${primary ? styles.primaryButton : styles.button} ${cardStyles.actionButton}`}
        disabled={busy || blocked}
        onClick={(): void => {
          void onRequest(request);
        }}
      >
        {label}
      </Button>
    );
  }

  const action = {
    verified: button('다시 확인', { operation: 'test-ai' }, false, issue),
    login: button('AI 호출 확인', { operation: 'test-ai' }, true, issue),
    required: button(
      `${providerName} 로그인`,
      { operation: 'connect-cli' },
      true,
      issue,
    ),
    waiting: button('로그인 완료 확인', { operation: 'check-cli-login' }, true),
    checking: undefined,
    unknown: button(
      `${providerName} 로그인`,
      { operation: 'connect-cli' },
      true,
      issue,
    ),
    error: undefined,
  }[level];
  return (
    <>
      <StatusNotice
        variant="box"
        data-level={level}
        tone={tones[level]}
        title={
          <>
            <span className={cardStyles.mark} aria-hidden="true">
              {level === 'verified' ? (
                <Icon name="check" size={16} />
              ) : level === 'error' ? (
                '×'
              ) : level === 'checking' || level === 'waiting' ? (
                <Icon name="clock" size={16} />
              ) : level === 'login' ? (
                'i'
              ) : (
                '!'
              )}
            </span>
            {title}
          </>
        }
        className={cardStyles.card}
        action={action}
      >
        {description}
        {level === 'error' && code && (
          <details>
            <summary>문제 상세</summary>
            <p className={styles.note}>
              오류 코드: <code>{code}</code>
            </p>
            {connection?.event && (
              <p className={styles.note}>
                멈춘 메시지 종류: <code>{connection.event}</code>
              </p>
            )}
            {canDiagnose && (
              <>
                <p className={styles.note}>
                  진단 보고서는 Claude를 한 번 호출해 실행 단계와 메시지 종류만
                  기록합니다. 경로·계정·응답 내용은 남기지 않습니다.
                </p>
                <Button
                  variant="surface"
                  type="button"
                  className={`${styles.button} ${cardStyles.actionButton}`}
                  disabled={busy}
                  onClick={(): void => {
                    void onRequest({ operation: 'diagnose-claude' });
                  }}
                >
                  {diagnosing ? '진단하는 중…' : '진단 보고서 만들기'}
                </Button>
                {diagnosticReport && !diagnosing && (
                  <p className={styles.note} role="status">
                    {diagnosticReport.message}
                    {diagnosticReport.path && (
                      <>
                        {' '}
                        <code>{diagnosticReport.path}</code>
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </details>
        )}
      </StatusNotice>
      {(level === 'required' || level === 'unknown') && (
        <button
          type="button"
          className={styles.foldButton}
          disabled={busy}
          onClick={(): void => {
            void onRequest({ operation: 'check-cli-login' });
          }}
        >
          이미 로그인했다면 다시 확인
          <span className={styles.chevron} aria-hidden="true">
            ›
          </span>
        </button>
      )}
      {level === 'waiting' && (
        <div className={styles.utilityActions}>
          {button('대기 취소', { operation: 'cancel-cli-login' }, false)}
        </div>
      )}
      {level === 'error' && (
        <>
          <div className={styles.utilityActions}>
            {button(
              '다시 시도',
              { operation: callFailed ? 'test-ai' : 'connect-cli' },
              true,
              issue,
            )}
            <Button
              variant="surface"
              type="button"
              className={`${styles.button} ${cardStyles.actionButton}`}
              aria-controls={advancedId}
              disabled={busy}
              onClick={onChangePath}
            >
              설치 위치 변경
            </Button>
          </div>
        </>
      )}
    </>
  );
}
