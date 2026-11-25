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
type Filter = NonNullable<NotificationListRequest['filter']>;
const filters: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'unread', label: '읽지 않음' },
  { value: 'approval', label: '내용 확인' },
];

/** 서버 알림을 현재 허용 범위에서 읽으며 읽음 처리와 승인을 분리합니다. */
export function NotificationList({
  scope,
}: NotificationListProps): JSX.Element {
  const navigate = useNavigate();
  const active = useWorkspaceActivity();
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<ListData | null>(null);
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
          if (notificationAccessLost(result.error)) setData(null);
          throw new Error(result.error.message);
        }
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
          if (notificationAccessLost(result.error)) setData(null);
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

  return (
    <section className={styles.page} aria-label="알림">
      <div className={styles.heading}>
        <div>
          <h1>알림</h1>
          <p>작업 공간의 문자 검토 요청과 처리 결과를 확인합니다.</p>
        </div>
        <div className={styles.actions}>
          <Button
            size="small"
            variant="secondary"
            disabled={
              busy ||
              !data?.items.some(
                (item: NotificationItem): boolean => !item.read_at,
              )
            }
            onClick={(): void => {
              if (data) void markRead(data.items);
            }}
          >
            표시된 알림 읽음
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={(): void => {
              void load();
            }}
          >
            새로고침
          </Button>
        </div>
      </div>
      <div className={styles.filters} aria-label="알림 필터">
        {filters.map((item: { value: Filter; label: string }): JSX.Element => (
          <Button
            key={item.value}
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
            {data && item.value === 'unread'
              ? ` ${data.unread_count}`
              : data && item.value === 'approval'
                ? ` ${data.approval_count}`
                : ''}
          </Button>
        ))}
      </div>
      {error && (
        <StatusNotice tone="error" title="알림 수신을 확인하지 못했습니다">
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
                <h2>{item.title}</h2>
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
                  {!item.read_at && <span className={styles.unread}>미독</span>}
                </div>
              </div>
              <time
                className={styles.notificationTime}
                dateTime={item.created_at}
              >
                {formatTimestamp(item.created_at)}
              </time>
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
      <p className={styles.receipt}>
        알림을 열면 해당 문서로 이동합니다. 앱이 닫힌 동안 서버에 기록된 알림은
        다음 연결 때 가져옵니다.
      </p>
    </section>
  );
}
