import { documentDisplayName } from '@renderer/domains/documents';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link } from 'react-router';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { useSessionCatalog } from '../model/useSessionCatalog';
import { useSessionActivity } from '../model/useSessionActivity';
import { useFinishedActivities } from '../model/useFinishedActivities';
import { activityKey } from '../model/finishedActivities';
import type { FinishedActivity } from '../model/finishedActivities';
import {
  kindLabel,
  newestFirst,
  notStarted,
} from '../model/sessionPresentation';
import type { SessionItem } from '../api/aiSessions.api';
import { SkeletonBar, SkeletonList } from '@renderer/shared/ui/Skeleton';
import styles from './SessionHistory.module.scss';

type KindFilter = 'all' | SessionItem['kind'];

/** 기록을 기다릴 때와 표시할 때 같은 열 구성을 사용합니다. */
function SessionHistoryTableHeader(): JSX.Element {
  return (
    <thead>
      <tr>
        <th className={styles.kindCol}>종류</th>
        <th>기록</th>
        <th className={styles.timeCol}>시작</th>
        <th className={styles.stateCol}>상태</th>
        <th className={styles.actionCol}>
          <span className={styles.srOnly}>열기</span>
        </th>
      </tr>
    </thead>
  );
}

/** 지난 기록에서 고를 수 있는 종류입니다. 저장된 목록에는 이 세 종류만 있습니다. */
const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'analysis', label: '문서 분석' },
  { value: 'question', label: 'AI 질문' },
  { value: 'comparison', label: '관련 지식 찾기' },
];

/** 상태 글자를 배지 색으로 바꿉니다. 모르는 상태는 중립 색입니다. */
function stateOf(
  item: SessionItem,
): 'complete' | 'running' | 'partial' | 'other' {
  if (item.status === '완료') return 'complete';
  if (item.status === '실행 중') return 'running';
  if (item.status === '일부 완료') return 'partial';
  return 'other';
}

/** 선택한 값이 알려진 종류가 아니면 전체로 둡니다. */
function toKindFilter(value: string): KindFilter {
  return (
    KIND_FILTERS.find(
      (option: { value: KindFilter }): boolean => option.value === value,
    )?.value ?? 'all'
  );
}

const noTarget = { sourceId: null, sourceVersion: null, document: null };

/** 끝난 작업을 종류로 좁혀 시각순으로 보여 주는 AI 세션의 하위 화면입니다. 조회만 하며 새 실행을 만들지 않습니다. */
export function SessionHistory(): JSX.Element {
  const model = useSessionCatalog(noTarget);
  const activity = useSessionActivity();
  const finished = useFinishedActivities();
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  // 아직 돌고 있거나 확인 전인 작업은 AI 세션 화면에 있으므로 여기서는 뺍니다.
  const activeKeys = new Set(
    (activity.snapshot?.activities ?? []).map(activityKey),
  );
  const finishedKeys = new Set(
    finished.items
      .filter(
        (item: FinishedActivity): boolean => !activeKeys.has(activityKey(item)),
      )
      .map(activityKey),
  );
  const items = newestFirst(
    (model.page?.items ?? []).filter(
      (item: SessionItem): boolean =>
        !activeKeys.has(activityKey(item)) &&
        !finishedKeys.has(activityKey(item)) &&
        !notStarted(item) &&
        (kindFilter === 'all' || item.kind === kindFilter),
    ),
  );
  const hasMore = !!(
    model.page?.cursors.analysis ||
    model.page?.cursors.question ||
    model.page?.cursors.comparison
  );
  const loading = model.busy && !model.page;
  return (
    <div className={styles.root}>
      <WorkspacePage title="지난 기록">
        <div className={styles.page}>
          {model.error && <p role="alert">{model.error}</p>}
          <div className={styles.toolbar}>
            <label className={styles.filter}>
              <span className={styles.srOnly}>종류 필터</span>
              <select
                aria-label="종류 필터"
                value={kindFilter}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                  setKindFilter(toKindFilter(event.target.value))
                }
              >
                {KIND_FILTERS.map(
                  (option: {
                    value: KindFilter;
                    label: string;
                  }): JSX.Element => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </label>
            {!loading && (
              <span className={styles.count}>불러온 범위 {items.length}건</span>
            )}
          </div>
          {loading && (
            <SkeletonList
              label="지난 기록을 불러오는 중"
              className={styles.historySkeleton}
            >
              <div className={styles.tableWrap} aria-hidden="true">
                <table className={styles.table}>
                  <SessionHistoryTableHeader />
                  <tbody>
                    {[0, 1, 2].map((index: number): JSX.Element => (
                      <tr key={index}>
                        <td>
                          <SkeletonBar shape="badge" />
                        </td>
                        <td>
                          <div className={styles.skeletonTitle}>
                            <SkeletonBar shape="title" />
                            <SkeletonBar shape="sub" />
                          </div>
                        </td>
                        <td>
                          <SkeletonBar shape="bar" />
                        </td>
                        <td>
                          <SkeletonBar shape="badge" />
                        </td>
                        <td className={styles.actionCol}>
                          <SkeletonBar shape="badge" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SkeletonList>
          )}
          {!loading && !model.error && items.length === 0 && (
            <div className={styles.empty}>
              <Icon name="history" size={24} />
              <p>
                {kindFilter === 'all'
                  ? '불러온 지난 기록이 없습니다.'
                  : '이 종류의 불러온 기록이 없습니다.'}
              </p>
            </div>
          )}
          {items.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <SessionHistoryTableHeader />
                <tbody>
                  {items.map((item: SessionItem): JSX.Element => (
                    <tr key={activityKey(item)}>
                      <td>
                        <span className={styles.badge}>
                          {kindLabel(item.kind)}
                        </span>
                      </td>
                      <td>
                        <span className={styles.title}>
                          {documentDisplayName(
                            item.title,
                            item.kind === 'question' ? item.title : undefined,
                          )}
                        </span>
                        <span className={styles.target}>
                          {documentDisplayName(item.target)}
                        </span>
                      </td>
                      <td className={styles.time}>
                        {item.createdAt ? formatTimestamp(item.createdAt) : '—'}
                      </td>
                      <td>
                        <span
                          className={styles.badge}
                          data-state={stateOf(item)}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className={styles.actionCol}>
                        {item.href ? (
                          <Link className={styles.open} to={item.href}>
                            열기 <Icon name="arrow-right" size={14} />
                          </Link>
                        ) : (
                          <span>대상 확인 필요</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {hasMore && (
            <Button
              variant="secondary"
              className={styles.more}
              onClick={model.loadMore}
              disabled={model.busy}
            >
              더 불러오기
            </Button>
          )}
          {model.page?.messages.map((message: string): JSX.Element => (
            <p role="status" key={message}>
              {message}
            </p>
          ))}
        </div>
      </WorkspacePage>
    </div>
  );
}
