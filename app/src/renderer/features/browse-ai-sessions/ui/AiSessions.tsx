import { documentDisplayName } from '@renderer/domains/documents';
import { useReadQueries } from '@renderer/shared/lib/readQueries';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { useEffect, useEffectEvent, useRef } from 'react';
import type { JSX } from 'react';
import type { AiActivity } from '@contracts/aiSessions.contract';
import { Link, useNavigate } from 'react-router';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { useSessionCatalog } from '../model/useSessionCatalog';
import { useSessionActivity } from '../model/useSessionActivity';
import { useFinishedActivities } from '../model/useFinishedActivities';
import { activityKey } from '../model/finishedActivities';
import type { FinishedActivity } from '../model/finishedActivities';
import {
  activityLocation,
  kindLabel,
  notStarted,
} from '../model/sessionPresentation';
import type { SessionFilter, SessionItem } from '../api/aiSessions.api';
import { SessionSkeleton } from './SessionSkeleton';
import styles from './AiSessions.module.scss';
import { KnowledgeComparisons } from './KnowledgeComparisons';

type AiSessionsProps = { filter: SessionFilter; comparisonId?: string | null };

/** 돌고 있는 작업과 확인 전 끝난 작업을 보여 주며 목록 조회는 새 실행을 만들지 않습니다. */
export function AiSessions({
  filter,
  comparisonId,
}: AiSessionsProps): JSX.Element {
  const { snapshot: readSnapshot } = useReadQueries();
  const active = useWorkspaceActivity();
  const model = useSessionCatalog(filter);
  const navigate = useNavigate();
  const activity = useSessionActivity();
  const finished = useFinishedActivities();
  const signature = activity.snapshot?.activities
    .map((item: AiActivity): string => `${item.kind}:${item.id}:${item.status}`)
    .sort()
    .join('|');
  const previousSignature = useRef<string | undefined>(undefined);
  const reloadOnActivity = useEffectEvent((): void => model.reload());
  useEffect((): void => {
    if (signature === undefined) return;
    if (
      previousSignature.current !== undefined &&
      previousSignature.current !== signature
    )
      reloadOnActivity();
    previousSignature.current = signature;
  }, [signature]);
  const activities = readSnapshot.failure
    ? []
    : (activity.snapshot?.activities.filter(
        (item: AiActivity): boolean =>
          !filter.sourceId &&
          (!filter.document || item.document === filter.document),
      ) ?? []);
  const activeKeys = new Set(activities.map(activityKey));
  const finishedRows = readSnapshot.failure
    ? []
    : finished.items.filter(
        (item: FinishedActivity): boolean =>
          !activeKeys.has(activityKey(item)) &&
          (!filter.document || item.document === filter.document),
      );
  const finishedKeys = new Set(finishedRows.map(activityKey));
  // 문서·원본에서 들어온 경우에만 그 대상의 저장된 작업을 함께 보여 줍니다.
  const targeted = !!(filter.document || filter.sourceId);
  const savedItems =
    model.page?.items.filter(
      (item: SessionItem): boolean =>
        !activeKeys.has(activityKey(item)) &&
        !finishedKeys.has(activityKey(item)) &&
        !notStarted(item),
    ) ?? [];
  const targetItems = targeted ? savedItems : [];
  const hasMore = !!(
    model.page?.cursors.analysis ||
    model.page?.cursors.question ||
    model.page?.cursors.comparison
  );
  const savedOf = (item: {
    kind: string;
    id: string;
  }): SessionItem | undefined =>
    model.page?.items.find(
      (candidate: SessionItem): boolean =>
        candidate.kind === item.kind && candidate.id === item.id,
    );
  const back = filter.document
    ? `/document?path=${encodeURIComponent(filter.document)}`
    : filter.sourceId
      ? `/source?sourceId=${encodeURIComponent(filter.sourceId)}${filter.sourceVersion ? `&version=${encodeURIComponent(filter.sourceVersion)}` : ''}`
      : null;
  const loading =
    active &&
    !model.error &&
    ((model.busy && !model.page) || (!activity.snapshot && !activity.error));
  const nothing =
    !model.error &&
    !loading &&
    activities.length === 0 &&
    finishedRows.length === 0 &&
    targetItems.length === 0;
  return (
    <div className={styles.root}>
      <WorkspacePage
        title="AI 세션"
        actions={
          <>
            {!targeted && (
              <Button
                variant="secondary"
                onClick={(): void => void navigate('/sessions/history')}
              >
                <Icon name="history" />
                지난 기록
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={model.reload}
              disabled={model.busy}
            >
              <Icon name="refresh-cw" />
              새로고침
            </Button>
          </>
        }
      >
        {back && <Link to={back}>대상 문서로 돌아가기</Link>}
        {activity.error && (
          <p role="status">현재 기기의 실행 상태: {activity.error}</p>
        )}
        {model.error && <p role="alert">{model.error}</p>}
        {loading &&
          activities.length === 0 &&
          finishedRows.length === 0 &&
          targetItems.length === 0 && <SessionSkeleton />}
        {activities.length > 0 && (
          <WorkspaceSection title="돌고 있는 작업">
            <ul className={styles.list}>
              {activities.map((item: AiActivity): JSX.Element => {
                const saved = savedOf(item);
                const href = activityLocation(item) ?? saved?.href;
                const key = activityKey(item);
                return (
                  <li key={key}>
                    <div>
                      <h3>
                        <span className={styles.kind}>
                          {kindLabel(item.kind)}
                        </span>
                        {saved?.title ??
                          (item.document
                            ? documentDisplayName(item.document)
                            : kindLabel(item.kind))}
                      </h3>
                      {item.document && (
                        <p>{documentDisplayName(item.document)}</p>
                      )}
                    </div>
                    <span className={styles.rowState}>
                      {item.status === 'starting'
                        ? '시작 중'
                        : item.status === 'stopping'
                          ? '중단 중'
                          : '실행 중'}
                    </span>
                    <div className={styles.rowActions}>
                      {href ? (
                        <Link to={href}>
                          열기 <Icon name="arrow-right" size={14} />
                        </Link>
                      ) : (
                        <span>대상 확인 필요</span>
                      )}
                      <button
                        type="button"
                        disabled={
                          !!activity.stopping || item.status === 'stopping'
                        }
                        aria-label={`이 작업 중단 · ${saved?.title ?? kindLabel(item.kind)}`}
                        onClick={(): void => {
                          void activity.stop(item);
                        }}
                      >
                        {activity.stopping === key || item.status === 'stopping'
                          ? '중단 중…'
                          : '중단'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </WorkspaceSection>
        )}
        {finishedRows.length > 0 && (
          <WorkspaceSection title="최근 끝난 작업">
            <ul className={styles.list}>
              {finishedRows.map((item: FinishedActivity): JSX.Element => {
                const saved = savedOf(item);
                const href =
                  saved?.href ??
                  activityLocation({
                    ...item,
                    connectionId: '',
                    status: 'running',
                    startedAt: item.endedAt,
                  });
                const title =
                  saved?.title ??
                  item.title ??
                  (item.document
                    ? documentDisplayName(item.document)
                    : kindLabel(item.kind));
                return (
                  <li key={activityKey(item)}>
                    <div>
                      <h3>
                        <span className={styles.kind}>
                          {kindLabel(item.kind)}
                        </span>
                        {title}
                      </h3>
                    </div>
                    <span className={styles.rowState}>
                      {saved?.status ?? item.result ?? '끝남'}
                    </span>
                    <div className={styles.rowActions}>
                      {href ? (
                        <Link
                          to={href}
                          onClick={(): void => finished.dismiss(item)}
                        >
                          열기 <Icon name="arrow-right" size={14} />
                        </Link>
                      ) : (
                        <span>대상 확인 필요</span>
                      )}
                      <button
                        type="button"
                        aria-label={`확인하고 목록에서 지우기 · ${title}`}
                        onClick={(): void => finished.dismiss(item)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </WorkspaceSection>
        )}
        {targetItems.length > 0 && (
          <WorkspaceSection title="이 대상의 작업">
            {filter.document && (
              <p>대상 문서: {documentDisplayName(filter.document)}</p>
            )}
            <ul className={styles.list}>
              {targetItems.map((item: SessionItem): JSX.Element => (
                <li key={activityKey(item)}>
                  <div>
                    <h3>
                      <span className={styles.kind}>
                        {kindLabel(item.kind)}
                      </span>
                      {documentDisplayName(
                        item.title,
                        item.kind === 'question' ? item.title : undefined,
                      )}
                    </h3>
                    <p>{documentDisplayName(item.target)}</p>
                  </div>
                  <span className={styles.rowState}>{item.status}</span>
                  <div className={styles.rowActions}>
                    {item.href ? (
                      <Link to={item.href}>
                        열기 <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : (
                      <span>대상 확인 필요</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {hasMore && (
              <button
                type="button"
                onClick={model.loadMore}
                disabled={model.busy}
              >
                더 불러오기
              </button>
            )}
          </WorkspaceSection>
        )}
        {nothing && (
          <div className={styles.empty}>
            <Icon name="bot" size={24} />
            <h3>돌고 있는 작업이 없습니다</h3>
            <p>
              문서에서 분석을 시작하거나 AI 채팅에서 질문하면 여기에 나타납니다.
            </p>
            <div className={styles.actions}>
              <Link to="/documents">문서 보기</Link>
              <Link to="/chat">AI 채팅</Link>
            </div>
          </div>
        )}
        {model.page?.messages.map((message: string): JSX.Element => (
          <p role="status" key={message}>
            {message}
          </p>
        ))}
        {/* 관련 지식 찾기 결과는 작업 상세에서 보며, 진행 항목에서 열었을 때만 여기에 펼칩니다. */}
        {comparisonId && !filter.sourceId && !readSnapshot.failure && (
          <KnowledgeComparisons
            key={`${filter.document ?? ''}:${comparisonId}`}
            jobId={null}
            documentPath={filter.document}
            comparisonId={comparisonId}
            watch={activities.some(
              (item: AiActivity): boolean => item.kind === 'comparison',
            )}
          />
        )}
      </WorkspacePage>
    </div>
  );
}
