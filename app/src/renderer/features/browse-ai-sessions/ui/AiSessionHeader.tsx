import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { AiActivity } from '@contracts/aiSessions.contract';
import { Link } from 'react-router';
import { getAiConnectionPresentation } from '@renderer/shared/lib/useAiConnection';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { useSessionActivity } from '../model/useSessionActivity';
import { useFinishedActivities } from '../model/useFinishedActivities';
import { readFinishedScope } from '../api/finishedRestore.api';
import { activityKey, recordFinished } from '../model/finishedActivities';
import type { FinishedActivity } from '../model/finishedActivities';
import { primaryUsageWindow } from '../model/sessionPresentation';
import { UsageBar } from './UsageBar';
import styles from './SessionActivity.module.scss';

type AiSessionHeaderProps = { connectionId: string | null };
const statusColors = {
  ok: 'var(--wiki-color-status-success)',
  info: 'var(--wiki-color-relation-machine)',
  warn: 'var(--wiki-color-status-warning)',
  bad: 'var(--wiki-color-status-danger)',
};

/** 헤더에는 전역 실행 수와 실제 계정 한도만 간결하게 표시합니다. */
export function AiSessionHeader({
  connectionId,
}: AiSessionHeaderProps): JSX.Element {
  const model = useSessionActivity(connectionId);
  const connection = useAiConnection();
  const count = model.snapshot?.activities.length ?? 0;
  const activities = model.snapshot?.activities;
  const finished = useFinishedActivities();
  // 아직 돌고 있는 작업은 "새 결과"로 세지 않습니다(목록 화면과 같은 기준).
  const runningKeys = new Set(
    (activities ?? []).map((item: AiActivity): string => activityKey(item)),
  );
  const newResults = finished.items.filter(
    (item: FinishedActivity): boolean => !runningKeys.has(activityKey(item)),
  ).length;
  const previous = useRef<AiActivity[] | null>(null);
  // 상태바는 항상 떠 있으므로 여기서 사라진 활동을 "끝난 작업"으로 기록합니다.
  useEffect((): void => {
    if (!activities || !connectionId) {
      previous.current = null;
      return;
    }
    if (previous.current) {
      const before = previous.current;
      // 확인 기록은 연결 ID가 아니라 사용자·공간 단위로 보관합니다.
      void readFinishedScope().then(
        ({ key }: { key: string }): void =>
          recordFinished(key, before, activities),
        (): void => undefined,
      );
    }
    previous.current = activities;
  }, [activities, connectionId]);
  // 런타임 조회가 불가능해도 실제 계정 수치는 표시하되, 다른 제공자의 한도는 섞지 않습니다.
  const account = model.snapshot?.usage;
  const usage =
    connection.provider === null || connection.provider === account?.provider
      ? account
      : undefined;
  const connected = connection.status === 'connected';
  const window =
    !model.error && (connected || connection.level === 'unknown')
      ? primaryUsageWindow(usage)
      : null;
  const provider =
    (connection.provider ?? usage?.provider) === 'claude'
      ? 'Claude'
      : (connection.provider ?? usage?.provider) === 'codex'
        ? 'Codex'
        : 'AI';
  const providerLabel =
    connection.model && connection.model !== 'default'
      ? `${provider} · ${connection.model}`
      : provider;
  const display = getAiConnectionPresentation(connection.level, providerLabel);
  const low = window !== null && window.remainingPercent <= 20;
  return (
    <div className={styles.header}>
      <Link
        to="/sessions"
        className={styles.sessionLink}
        aria-label={`AI 세션${count ? ` ${count} · 실행 중` : ''}${newResults ? ` · 새 결과 ${newResults}` : ''} 목록`}
      >
        <span
          className={
            count
              ? styles.runningDot
              : newResults
                ? styles.doneDot
                : styles.idleDot
          }
          aria-hidden="true"
        />
        <span>
          AI 세션{count ? ` ${count}` : ''}
          {!count && newResults ? ` · 새 결과 ${newResults}` : ''}{' '}
          <span aria-hidden="true">›</span>
        </span>
      </Link>
      {connectionId && (
        <Link
          to={
            connected
              ? '/settings?section=ai#account-usage'
              : '/settings?section=ai'
          }
          className={connected ? styles.usageLink : styles.connectLink}
          data-low={low}
          title={
            connected ? (model.error ?? usage?.message ?? undefined) : undefined
          }
        >
          <span>
            <span style={{ color: statusColors[display.tone] }}>
              {display.word}
            </span>
            {connected &&
              (model.error || usage?.status === 'error') &&
              ' · 한도 조회 실패'}
            {window &&
              ` · ${connected ? '' : `${provider} `}잔여 ${Math.round(window.remainingPercent)}%${usage?.stale ? ' · 이전 조회' : ''}`}
          </span>
          {window && (
            <UsageBar
              compact
              remainingPercent={window.remainingPercent}
              label={`${provider} ${window.name} 계정 잔여 한도`}
            />
          )}
        </Link>
      )}
    </div>
  );
}
