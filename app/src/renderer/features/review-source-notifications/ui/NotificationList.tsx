import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import type {
  NotificationItem,
  NotificationListRequest,
  NotificationListResult,
} from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { IconButton } from '@renderer/shared/ui/IconButton';
import { Tooltip } from '@renderer/shared/ui/Tooltip';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { notificationsApi } from '../api/notifications.api';
import {
  notificationAccessLost,
  notificationEventLabel,
  notificationSession,
  notificationWorkflowPath,
  workflowStateLabel,
} from '../model/notificationView';
import styles from './Notifications.module.scss';

type NotificationListProps = { scope: SourceConversionScope };
type ListData = Extract<NotificationListResult, { ok: true }>['data'];
type ListCounts = Pick<
  ListData,
  'total_count' | 'unread_count' | 'approval_count'
>;
type Filter = NonNullable<NotificationListRequest['filter']>;
const filters: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'unread', label: '읽지 않음' },
  { value: 'approval', label: '내용 확인 필요' },
];

/** 서버 알림을 현재 허용 범위에서 읽으며 읽음 처리와 승인을 분리합니다. */
export function NotificationList({
  scope,
}: NotificationListProps): JSX.Element {
  const navigate = useNavigate();
  const active = useWorkspaceActivity();
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<ListData | null>(null);
  const [counts, setCounts] = useState<ListCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const live = useRef(true);
  const load = useCallback(
    async (cursor: string | null = null): Promise<void> => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      const request = ++generation.current;
      try {
        const result = await notificationsApi.list({
          ...notificationSession(scope),
          filter,
          cursor,
          limit: 50,
        });
        if (!live.current || request !== generation.current) return;
        if (!result.ok) {
          if (notificationAccessLost(result.error)) {
            setData(null);
            setCounts(null);
          }
          throw new Error(result.error.message);
        }
        setCounts({
          total_count: result.data.total_count,
          unread_count: result.data.unread_count,
          approval_count: result.data.approval_count,
        });
        setData((previous: ListData | null): ListData => {
          if (!cursor || !previous) return result.data;
          const items = new Map(
            previous.items.map(
              (item: NotificationItem): [string, NotificationItem] => [
                item.notification_id,
                item,
              ],
            ),
          );
          result.data.items.forEach((item: NotificationItem): void => {
            items.set(item.notification_id, item);
          });
          return { ...result.data, items: [...items.values()] };
        });
        setReceivedAt(new Date().toISOString());
        setError(null);
      } catch (cause: unknown) {
        if (live.current && request === generation.current)
          setError(
            cause instanceof Error
              ? cause.message
              : '알림을 가져오지 못했습니다. 다시 확인해 주세요.',
          );
      } finally {
        pending.current = false;
        if (live.current && request === generation.current) setBusy(false);
      }
    },
    [filter, scope],
  );

  useEffect((): (() => void) => {
    live.current = true;
    return (): void => {
      live.current = false;
    };
  }, []);
  useEffect((): void => {
    queueMicrotask((): void => {
      if (live.current) void load();
    });
  }, [load]);
  useEffect((): (() => void) | undefined => {
    if (!active) return;
    const refresh = (): void => {
      void load();
    };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return (): void => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [active, load]);

  /** 화면에 받은 미독 사건만 읽음으로 저장하며 페이지 확인은 바꾸지 않습니다. */
  async function markRead(items: readonly NotificationItem[]): Promise<void> {
    if (pending.current) return;
    const ids = items
      .filter((item: NotificationItem): boolean => !item.read_at)
      .map((item: NotificationItem): string => item.notification_id);
    if (!ids.length) return;
    pending.current = true;
    setBusy(true);
    try {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await notificationsApi.markRead({
          ...notificationSession(scope),
          notificationIds: ids.slice(offset, offset + 100),
          read: true,
        });
        if (!live.current) return;
        if (!result.ok) {
          if (notificationAccessLost(result.error)) {
            setData(null);
            setCounts(null);
          }
          throw new Error(result.error.message);
        }
      }
      setError(null);
    } catch (cause: unknown) {
      if (live.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '읽음 상태를 저장하지 못했습니다.',
        );
    } finally {
      pending.current = false;
      if (live.current) {
        setBusy(false);
        void load();
      }
    }
  }

  /** 서버 확인을 받은 뒤 개인 목록에서만 제거하며 문서 작업은 유지합니다. */
  async function dismiss(item: NotificationItem): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    let saved = false;
    try {
      const result = await notificationsApi.dismiss({
        ...notificationSession(scope),
        notificationIds: [item.notification_id],
      });
      if (!live.current) return;
      if (!result.ok) {
        if (notificationAccessLost(result.error)) {
          setData(null);
          setCounts(null);
        }
        throw new Error(result.error.message);
      }
      setData((previous: ListData | null): ListData | null =>
        previous
          ? {
              ...previous,
              items: previous.items.filter(
                (entry: NotificationItem): boolean =>
                  entry.notification_id !== item.notification_id,
              ),
            }
          : null,
      );
      setError(null);
      saved = true;
    } catch (cause: unknown) {
      if (live.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '알림 삭제를 확인하지 못했습니다. 새로고침해 확인해 주세요.',
        );
    } finally {
      pending.current = false;
      if (live.current) {
        setBusy(false);
        if (saved) void load();
      }
    }
  }

  return (
    <section className={styles.page} aria-label="알림">
      <div className={styles.heading}>
        <div>
          <h1>알림</h1>
          <p>작업 공간의 문자 검토 요청과 처리 결과를 확인합니다.</p>
        </div>
        <div className={styles.actions}>
          <IconButton
            size="small"
            icon="check-check"
            label="표시된 알림 읽음"
            disabled={
              busy ||
              !data?.items.some(
                (item: NotificationItem): boolean => !item.read_at,
              )
            }
            onClick={(): void => {
              if (data) void markRead(data.items);
            }}
          />
          <IconButton
            size="small"
            icon="refresh-cw"
            label="새로고침"
            disabled={busy}
            onClick={(): void => {
              void load();
            }}
          />
        </div>
      </div>
      <div className={styles.filters} role="group" aria-label="알림 필터">
        {filters.map((item: { value: Filter; label: string }): JSX.Element => {
          const count = !counts
            ? undefined
            : item.value === 'unread'
              ? counts.unread_count
              : item.value === 'approval'
                ? counts.approval_count
                : counts.total_count;
          return (
            <Button
              key={item.value}
              className={styles.filterButton}
              size="small"
              variant="surface"
              aria-pressed={filter === item.value}
              disabled={busy}
              onClick={(): void => {
                setFilter(item.value);
                setData(null);
                setReceivedAt(null);
              }}
            >
              {item.label}
              <span
                className={styles.filterCount}
                aria-label={count === undefined ? '개수 확인 중' : `${count}개`}
              >
                {count ?? '—'}
              </span>
            </Button>
          );
        })}
        <IconButton
          icon="circle-help"
          label="알림 필터 설명"
          description="읽지 않음은 아직 읽음 처리하지 않은 알림입니다. 내용 확인 필요는 등록할 문자의 검토가 남은 문서이며, 알림을 읽어도 유지됩니다."
        />
      </div>
      {error && (
        <StatusNotice tone="error" title="알림 상태를 확인하지 못했습니다">
          {error}
          {data && (
            <p>
              아래는 마지막으로 받은 기록입니다. 최신 상태는 다시 확인해 주세요.
            </p>
          )}
        </StatusNotice>
      )}
      <p className={styles.receipt} role="status">
        {busy
          ? '알림을 확인하고 있습니다…'
          : receivedAt
            ? `마지막 수신 ${formatTimestamp(receivedAt)} · 서버에 보관된 알림`
            : error
              ? '수신 상태 미확인'
              : '알림을 불러오고 있습니다…'}
      </p>
      {data && (
        <div className={styles.notificationList}>
          {!data.items.length && (
            <p className={styles.empty}>
              {filter === 'approval'
                ? '내용을 확인할 문서가 없습니다.'
                : filter === 'unread'
                  ? '읽지 않은 알림이 없습니다.'
                  : '보관된 알림이 없습니다.'}
            </p>
          )}
          {data.items.map((item: NotificationItem): JSX.Element => (
            <article
              key={item.notification_id}
              className={styles.notification}
              data-notification-row
            >
              <span
                className={styles.eventIcon}
                data-complete={item.kind === 'completed'}
              >
                <Icon
                  name={
                    item.kind === 'completed'
                      ? 'circle-check'
                      : 'triangle-alert'
                  }
                  size={16}
                />
              </span>
              <div className={styles.notificationBody}>
                <h2>
                  <Tooltip label={item.title} className={styles.titleTooltip}>
                    {(descriptionId: string | undefined): JSX.Element => (
                      <span
                        tabIndex={0}
                        className={styles.notificationTitle}
                        aria-describedby={descriptionId}
                      >
                        {item.title}
                      </span>
                    )}
                  </Tooltip>
                </h2>
                <div className={styles.notificationMeta}>
                  <span>{notificationEventLabel(item.kind)}</span>
                  {item.warning_count > 0 && (
                    <span>{item.warning_count}쪽 확인</span>
                  )}
                  {workflowStateLabel(item.state, item.blocked_reason) !==
                    notificationEventLabel(item.kind) && (
                    <span>
                      {workflowStateLabel(item.state, item.blocked_reason)}
                    </span>
                  )}
                  {!item.read_at && (
                    <span className={styles.unread}>읽지 않음</span>
                  )}
                </div>
              </div>
              <time
                className={styles.notificationTime}
                dateTime={item.created_at}
              >
                {formatTimestamp(item.created_at)}
              </time>
              <div className={styles.notificationActions}>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={(): void => {
                    void markRead([item]);
                    void navigate(notificationWorkflowPath(item.workflow_id));
                  }}
                >
                  {item.state === 'review' ? '내용 확인' : '문서 보기'}
                </Button>
                <IconButton
                  size="small"
                  icon="trash-2"
                  disabled={busy}
                  label={`${item.title} 알림 삭제`}
                  onClick={(): void => {
                    void dismiss(item);
                  }}
                />
              </div>
            </article>
          ))}
        </div>
      )}
      {data?.next_cursor && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={(): void => {
            void load(data.next_cursor);
          }}
        >
          이전 알림 더 보기
        </Button>
      )}
    </section>
  );
}
