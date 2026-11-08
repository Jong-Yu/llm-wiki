import { useEffect, useEffectEvent, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData, QueryFunctionContext } from '@tanstack/react-query';
import {
  ReadQueryError,
  useReadQueries,
} from '@renderer/shared/lib/readQueries';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  readSessionPage,
  readSessionScope,
  SessionScopeError,
} from '../api/aiSessions.api';
import type {
  SessionFilter,
  SessionItem,
  SessionPage,
  SessionCursors,
} from '../api/aiSessions.api';

type SessionCatalog = {
  page: SessionPage | null;
  error: string | null;
  busy: boolean;
  reload: () => void;
  loadMore: () => void;
};

/** 다음 커서는 이번 페이지를 따르고 실제 누락만 앞 페이지에서 계속 보존합니다. */
export function mergeSessionPages(
  previous: SessionPage | null,
  result: SessionPage,
): SessionPage {
  const merged = new Map<string, SessionItem>();
  for (const item of [...(previous?.items ?? []), ...result.items])
    merged.set(`${item.kind}:${item.id}`, item);
  const hasGaps = result.hasGaps || (previous?.hasGaps ?? false);
  return {
    ...result,
    items: [...merged.values()],
    messages: [...new Set([...(previous?.messages ?? []), ...result.messages])],
    hasGaps,
    incomplete:
      hasGaps ||
      result.cursors.analysis !== null ||
      result.cursors.question !== null ||
      result.cursors.comparison !== null,
  };
}

/** 서버 cursor별 페이지를 공유하며 복귀에는 기존 자료를 보존한 채 다시 확인합니다. */
export function useSessionCatalog(filter: SessionFilter): SessionCatalog {
  const active = useWorkspaceActivity();
  const { cache, snapshot } = useReadQueries();
  const wasActive = useRef(active);
  const { sourceId, sourceVersion, document } = filter;
  const query = useInfiniteQuery({
    queryKey: cache.key('session-catalog', sourceId, sourceVersion, document),
    enabled: active && !snapshot.failure,
    initialPageParam: null,
    queryFn: async (
      context: QueryFunctionContext<readonly unknown[], SessionCursors | null>,
    ): Promise<SessionPage> => {
      try {
        const scope = await readSessionScope();
        const result = await readSessionPage(
          scope,
          { sourceId, sourceVersion, document },
          context.pageParam,
        );
        context.signal.throwIfAborted();
        return result;
      } catch (cause) {
        throw new ReadQueryError({
          code:
            cause instanceof SessionScopeError
              ? 'scope_changed'
              : 'sessions_failed',
          message:
            cause instanceof Error
              ? cause.message
              : 'AI 세션을 읽지 못했습니다.',
        });
      }
    },
    getNextPageParam: (last: SessionPage): SessionCursors | null =>
      Object.values(last.cursors).some(
        (cursor: string | null): boolean => cursor !== null,
      )
        ? last.cursors
        : null,
  });
  const page =
    query.data?.pages.reduce<SessionPage | null>(mergeSessionPages, null) ??
    null;
  const revalidate = useEffectEvent((): void => {
    if (!snapshot.failure) void query.refetch({ cancelRefetch: false });
  });
  useEffect((): void => {
    if (active && !wasActive.current) revalidate();
    wasActive.current = active;
  }, [active]);
  return {
    page: snapshot.failure ? null : page,
    error:
      snapshot.failure?.message ??
      (query.error instanceof Error ? query.error.message : null),
    busy: query.isFetching,
    reload: (): void => {
      if (snapshot.failure) cache.clear();
      else {
        // 명시 새로고침은 기존 계약처럼 첫 페이지에서 다시 시작합니다.
        cache.client.setQueryData<
          InfiniteData<SessionPage, SessionCursors | null>
        >(
          cache.key('session-catalog', sourceId, sourceVersion, document),
          (
            previous:
              | InfiniteData<SessionPage, SessionCursors | null>
              | undefined,
          ): InfiniteData<SessionPage, SessionCursors | null> | undefined =>
            previous
              ? {
                  pages: previous.pages.slice(0, 1),
                  pageParams: previous.pageParams.slice(0, 1),
                }
              : previous,
        );
        void query.refetch({ cancelRefetch: false });
      }
    },
    loadMore: (): void => {
      if (active && !snapshot.failure && query.hasNextPage && !query.isFetching)
        void query.fetchNextPage({ cancelRefetch: false });
    },
  };
}
