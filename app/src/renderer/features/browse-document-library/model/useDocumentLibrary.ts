import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueryFunctionContext } from '@tanstack/react-query';
import {
  ReadQueryError,
  useReadQueries,
} from '@renderer/shared/lib/readQueries';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { queryDocumentLibrary } from '../api/documentLibrary.queries';
import type { LibraryOutcome, LibraryRequest } from './documentLibrary.types';

type LibraryState = { status: 'loading' } | LibraryOutcome;
type DocumentLibraryModel = {
  state: LibraryState;
  refreshing: boolean;
  refreshError: string | null;
  request: LibraryRequest;
  search: (query: string) => void;
  refresh: () => void;
  revalidate: () => void;
  next: () => void;
  previous: () => void;
};

// 탐색 위치는 조회 캐시와 분리해 같은 앱 세션에서 유지합니다.
export const libraryNavigation: {
  request: LibraryRequest;
  query: string;
  filter: string;
  selected: string | null;
} = {
  request: { query: '', cursor: null, previousCursors: [] },
  query: '',
  filter: 'all',
  selected: null,
};

/** 앱 세션 캐시는 로그아웃·계정·관점 전환 시 읽기 조건까지 비웁니다. */
function clearLibraryNavigation(): void {
  libraryNavigation.request = { query: '', cursor: null, previousCursors: [] };
  Object.assign(libraryNavigation, {
    query: '',
    filter: 'all',
    selected: null,
  });
}
// 화면을 떠나 있는 동안에도 캐시와 같은 앱 수명으로 범위 변경을 받습니다.
window.addEventListener('wiki-connection-changed', clearLibraryNavigation);

/** 열기 직전의 사용자 탐색 선택만 보관합니다. */
export function rememberLibraryNavigation(
  query: string,
  filter: string,
  selected: string,
): void {
  Object.assign(libraryNavigation, { query, filter, selected });
}

/** 조회 수명과 서버 cursor를 관리하며 실패해도 사용자가 입력한 검색어는 보존합니다. */
export function useDocumentLibrary(): DocumentLibraryModel {
  const { cache, snapshot } = useReadQueries();
  const active = useWorkspaceActivity();
  const [request, setCurrentRequest] = useState<LibraryRequest>(
    libraryNavigation.request,
  );
  /** 검색·페이지를 현재 조회 범위와 함께 보관합니다. */
  function setRequest(value: LibraryRequest): void {
    libraryNavigation.request = value;
    setCurrentRequest(value);
  }
  const queryKey = cache.key('document-library', request.query, request.cursor);
  const query = useQuery({
    queryKey,
    enabled: active && !snapshot.failure,
    queryFn: async (context: QueryFunctionContext): Promise<LibraryOutcome> => {
      const outcome = await queryDocumentLibrary(request);
      context.signal.throwIfAborted();
      if (outcome.status === 'error')
        throw new ReadQueryError(
          outcome.failure ?? {
            code: 'library_failed',
            message: outcome.message,
          },
        );
      if (outcome.status === 'unselected')
        throw new ReadQueryError({
          code: 'selection_required',
          message: '작업 공간을 선택해 주세요.',
        });
      return outcome;
    },
  });
  useEffect((): void => {
    if (query.data?.status === 'ready')
      libraryNavigation.request = {
        ...request,
        expectedScope: query.data.result.scope,
      };
  }, [query.data, request]);
  const failure =
    snapshot.failure ??
    (query.error instanceof ReadQueryError ? query.error.failure : null);
  const state: LibraryState = snapshot.failure
    ? snapshot.failure.code === 'selection_required'
      ? { status: 'unselected' }
      : { status: 'error', message: snapshot.failure.message }
    : (query.data ??
      (failure
        ? { status: 'error', message: failure.message }
        : { status: 'loading' }));
  /** 복귀와 명시 검색은 같은 결과를 보존하면서 최신 페이지를 읽습니다. */
  function revalidate(): void {
    if (snapshot.failure) cache.clear();
    else if (active) void query.refetch({ cancelRefetch: false });
  }
  return {
    state,
    refreshing: query.isFetching && Boolean(query.data),
    refreshError:
      !snapshot.failure && query.data ? (failure?.message ?? null) : null,
    request,
    search: (text: string): void => {
      const value = text.trim();
      if (value === request.query && request.cursor === null) revalidate();
      else setRequest({ query: value, cursor: null, previousCursors: [] });
    },
    refresh: (): void => {
      if (snapshot.failure) cache.clear();
      else
        void cache.client.invalidateQueries({
          queryKey: cache.key('document-library'),
          refetchType: 'none',
        });
      setRequest({ query: request.query, cursor: null, previousCursors: [] });
      if (request.cursor === null && !snapshot.failure)
        void query.refetch({ cancelRefetch: false });
    },
    revalidate,
    next: (): void => {
      if (state.status !== 'ready' || !state.result.nextCursor) return;
      setRequest({
        ...request,
        cursor: state.result.nextCursor,
        previousCursors: [...request.previousCursors, request.cursor],
        expectedScope: state.result.scope,
      });
    },
    previous: (): void => {
      if (state.status !== 'ready' || request.previousCursors.length === 0)
        return;
      setRequest({
        ...request,
        cursor: request.previousCursors.at(-1) ?? null,
        previousCursors: request.previousCursors.slice(0, -1),
        expectedScope: state.result.scope,
      });
    },
  };
}
