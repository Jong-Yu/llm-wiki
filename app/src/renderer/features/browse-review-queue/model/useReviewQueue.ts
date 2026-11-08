import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { readReviewQueuePage, ReviewQueueError } from '../api/reviewQueue.api';
import { mergeReviewQueuePages } from './reviewQueuePages';
import { reviewStateSchema } from './reviewQueue.schema';
import type { ReviewQueuePage, ReviewQueueState } from './reviewQueue.types';

type ReviewQueueModel = {
  page: ReviewQueuePage | null;
  busy: boolean;
  error: string | null;
  refreshRequired: boolean;
  reload: () => void;
  loadMore: () => void;
};

/** 활성 화면에서만 목록을 읽고 필터·접근 범위가 바뀐 응답은 폐기합니다. */
export function useReviewQueue(
  states: readonly ReviewQueueState[],
): ReviewQueueModel {
  const active = useWorkspaceActivity();
  const [page, setPage] = useState<ReviewQueuePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [loadedFilter, setLoadedFilter] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const currentPage = useRef<ReviewQueuePage | null>(null);
  const needsRefresh = useRef(false);
  const filterKey = [...states].sort().join('|');
  const selected = useMemo(
    (): ReviewQueueState[] =>
      reviewStateSchema.array().parse(filterKey ? filterKey.split('|') : []),
    [filterKey],
  );

  const read = useCallback(
    async (more: boolean): Promise<void> => {
      if (!active || pending.current || (more && needsRefresh.current)) return;
      const previous = more ? currentPage.current : null;
      if (more && !previous?.nextCursor) return;
      const request = ++generation.current;
      pending.current = true;
      setBusy(true);
      setError(null);
      if (!more) {
        currentPage.current = null;
        setPage(null);
        setLoadedFilter(null);
        needsRefresh.current = false;
        setRefreshRequired(false);
      }
      try {
        const result = await readReviewQueuePage(
          selected,
          previous?.nextCursor ?? null,
        );
        if (request !== generation.current) return;
        const next = mergeReviewQueuePages(previous, result);
        currentPage.current = next;
        setPage(next);
        setLoadedFilter(filterKey);
        needsRefresh.current = next.requiresRefresh;
        setRefreshRequired(next.requiresRefresh);
      } catch (cause: unknown) {
        if (request !== generation.current) return;
        if (cause instanceof ReviewQueueError && cause.invalidatesScope) {
          currentPage.current = null;
          setPage(null);
          setLoadedFilter(null);
        }
        if (cause instanceof ReviewQueueError && cause.requiresRefresh) {
          needsRefresh.current = true;
          setRefreshRequired(true);
          if (currentPage.current) {
            currentPage.current = {
              ...currentPage.current,
              requiresRefresh: true,
            };
            setPage(currentPage.current);
          }
        }
        setError(
          cause instanceof Error
            ? cause.message
            : '검토 목록을 읽지 못했습니다. 새로고침해 주세요.',
        );
      } finally {
        if (request === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [active, filterKey, selected],
  );

  useEffect((): (() => void) => {
    generation.current += 1;
    pending.current = false;
    const activation = generation.current;
    // 개발 StrictMode의 폐기된 활성화는 요청하지 않고 복귀한 화면은 첫 페이지부터 확인합니다.
    queueMicrotask((): void => {
      if (active && activation === generation.current) void read(false);
    });
    const changed = (): void => {
      generation.current += 1;
      pending.current = false;
      currentPage.current = null;
      needsRefresh.current = false;
      setPage(null);
      setLoadedFilter(null);
      setError(null);
      setBusy(false);
      setRefreshRequired(false);
      if (active) void read(false);
    };
    window.addEventListener('wiki-connection-changed', changed);
    return (): void => {
      generation.current += 1;
      pending.current = false;
      window.removeEventListener('wiki-connection-changed', changed);
    };
  }, [active, read]);

  return {
    page: loadedFilter === filterKey ? page : null,
    busy,
    error,
    refreshRequired,
    reload: (): void => {
      void read(false);
    },
    loadMore: (): void => {
      void read(true);
    },
  };
}
