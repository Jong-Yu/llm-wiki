import type { JSX } from 'react';
import type { AccountUsageWindow } from '@contracts/aiSessions.contract';
import { formatTimestampWithZone } from '@renderer/shared/lib/formatTimestamp';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { useSessionActivity } from '../model/useSessionActivity';
import {
  primaryUsageWindow,
  resetDateLabel,
  usageTime,
} from '../model/sessionPresentation';
import { SkeletonBar, SkeletonList } from '@renderer/shared/ui/Skeleton';
import { UsageBar } from './UsageBar';
import styles from './SessionActivity.module.scss';

/** 계정 한도와 개별 실행 토큰을 혼합하지 않고 미제공·오래된 조회를 드러냅니다. */
export function AccountUsagePanel(): JSX.Element {
  const model = useSessionActivity();
  const usage = model.snapshot?.usage;
  const primary = primaryUsageWindow(usage);
  const providerName = usage?.provider === 'codex' ? 'Codex' : 'Claude';
  return (
    <WorkspaceSection
      title="AI 계정 사용량"
      className={styles.usagePanel}
      id="account-usage"
      actions={
        <button type="button" disabled={model.busy} onClick={model.refresh}>
          {model.busy ? '확인 중…' : '사용량 새로고침'}
        </button>
      }
    >
      <p className={styles.usageScope}>모든 세션이 공유하는 계정 한도</p>
      {model.error && <p role="alert">{model.error}</p>}
      {!usage && !model.error && (
        <SkeletonList
          label="계정 한도를 불러오는 중"
          className={styles.usageSkeleton}
        >
          <div className={styles.usageIdentity} aria-hidden="true">
            <p>
              <SkeletonBar shape="badge" />
            </p>
            <span>
              <SkeletonBar shape="badge" />
            </span>
          </div>
          {[0, 1].map((index: number): JSX.Element => (
            <article className={styles.window} key={index} aria-hidden="true">
              <div className={styles.panelHeader}>
                <h3>
                  <SkeletonBar shape="badge" />
                </h3>
                <span className={styles.windowRemaining}>
                  <SkeletonBar shape="badge" />
                </span>
              </div>
              <SkeletonBar shape="bar" className={styles.usageSkeletonBar} />
              <div className={styles.windowFacts}>
                <SkeletonBar shape="badge" />
                <SkeletonBar shape="badge" />
              </div>
            </article>
          ))}
        </SkeletonList>
      )}
      {usage && (
        <>
          {usage.status !== 'available' && (
            <p role="status">
              {usage.message ??
                (usage.status === 'error'
                  ? '계정 한도를 읽지 못했습니다.'
                  : '현재 제공자가 계정 한도를 제공하지 않습니다.')}
            </p>
          )}
          {usage.stale && (
            <p role="status">
              이전 조회값입니다. 새로고침해 현재 한도를 확인해 주세요.
            </p>
          )}
          <div className={styles.usageIdentity}>
            <p>
              {providerName}
              {primary
                ? ` 연결됨 · 잔여 ${Math.round(primary.remainingPercent)}%`
                : ''}
              {usage.accountLabel ? ` · ${usage.accountLabel}` : ''}
            </p>
            <dl className={styles.usageChecked}>
              <dt>마지막 확인</dt>
              <dd
                title={
                  usage.checkedAt
                    ? formatTimestampWithZone(usage.checkedAt)
                    : undefined
                }
              >
                {usageTime(usage.checkedAt)}
              </dd>
            </dl>
          </div>
          {usage.status === 'available' &&
            usage.windows.map((item: AccountUsageWindow): JSX.Element => (
              <article className={styles.window} key={item.name}>
                <div className={styles.panelHeader}>
                  <h3>{item.name}</h3>
                  <span className={styles.windowRemaining}>
                    잔여 {Math.round(item.remainingPercent)}%
                    {resetDateLabel(item.resetsAt) && (
                      <span
                        title={formatTimestampWithZone(item.resetsAt ?? '')}
                      >
                        {' '}
                        · 초기화 {resetDateLabel(item.resetsAt)}
                      </span>
                    )}
                  </span>
                </div>
                <UsageBar
                  remainingPercent={item.remainingPercent}
                  label={`${item.name} 계정 잔여 한도`}
                />
                <dl className={styles.windowFacts}>
                  <div>
                    <dt>사용</dt>
                    <dd>{Math.round(item.usedPercent)}%</dd>
                  </div>
                  <div>
                    <dt>한도 기간</dt>
                    <dd>
                      {item.windowMinutes === null
                        ? '미제공'
                        : `${item.windowMinutes.toLocaleString('ko-KR')}분`}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
        </>
      )}
    </WorkspaceSection>
  );
}
