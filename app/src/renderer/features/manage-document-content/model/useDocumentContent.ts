import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import {
  ReadQueryError,
  useReadQueries,
} from '@renderer/shared/lib/readQueries';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  documentContentOptions,
  isolateContentSession,
} from '../api/documentContent.queries';
import { verifyContentScope } from '../api/documentContent.api';
import type {
  ContentFailure,
  ContentSession,
} from '../api/documentContent.api';

type ContentState =
  | { status: 'loading' }
  | { status: 'error'; error: ContentFailure }
  | { status: 'ready'; session: ContentSession };
export type DocumentContentModel = {
  state: ContentState;
  refreshing: boolean;
  refreshError: string | null;
  retry: () => void;
  invalidate: () => void;
};

/** 읽기 결과만 공유하고 편집 중 본문·기준 판본은 기존 편집 모델에 남깁니다. */
export function useDocumentContent(
  path: string,
  editing: boolean,
): DocumentContentModel {
  const active = useWorkspaceActivity();
  const { cache, snapshot } = useReadQueries();
  const query = useQuery({
    ...documentContentOptions(cache, path),
    select: isolateContentSession,
    refetchOnMount: 'always',
    enabled: (value: Query<ContentSession, Error>): boolean =>
      active &&
      !snapshot.failure &&
      (!editing || value.state.data === undefined),
  });
  const current = query.data?.current;
  useEffect((): (() => void) | undefined => {
    if (!current || !active || snapshot.failure) return;
    let alive = true;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      const valid = await verifyContentScope(current);
      checking = false;
      if (!valid && alive)
        cache.deny({
          code: 'scope_changed',
          message:
            '현재 연결과 권한을 다시 확인해 주세요. 초안은 원래 기준으로 보존됩니다.',
        });
    };
    const interval = window.setInterval((): void => {
      void check();
    }, 5000);
    void check();
    return (): void => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [cache, current, active, snapshot.failure]);
  const error =
    snapshot.failure ??
    (query.error instanceof ReadQueryError ? query.error.failure : null);
  const state: ContentState = snapshot.failure
    ? { status: 'error', error: snapshot.failure }
    : query.data
      ? { status: 'ready', session: query.data }
      : error
        ? { status: 'error', error }
        : { status: 'loading' };
  return {
    state,
    refreshing: query.isFetching && Boolean(query.data),
    refreshError:
      !snapshot.failure && query.data ? (error?.message ?? null) : null,
    retry: (): void => {
      if (snapshot.failure) cache.clear();
      else void query.refetch({ cancelRefetch: false });
    },
    invalidate: (): void =>
      cache.deny({
        code: 'scope_changed',
        message:
          '현재 연결과 권한을 다시 확인해 주세요. 기존 초안은 원래 기준으로 보존됩니다.',
      }),
  };
}
