import { QueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryFunctionContext,
  UseInfiniteQueryOptions,
} from '@tanstack/react-query';
import type {
  OntologyNeighborsInput,
  OntologyNeighborPage,
  OntologySearchInput,
  OntologySearchPage,
} from '@contracts/ontologyExploration.contract';
import type {
  OntologyFailure,
  OntologyOutcome,
  OntologyScope,
} from '../model/ontologyMap.types';
import {
  loadOntologyNeighbors,
  searchOntology,
} from './ontologyExploration.api';

/** 실패를 성공 자료로 캐시하지 않고 기존 공개 오류를 그대로 전달합니다. */
export class OntologyQueryError extends Error {
  readonly failure: OntologyFailure;
  constructor(failure: OntologyFailure) {
    super(failure.message);
    this.name = 'OntologyQueryError';
    this.failure = failure;
  }
}

type OntologySearchQueryOptions = UseInfiniteQueryOptions<
  OntologySearchPage,
  OntologyQueryError,
  InfiniteData<OntologySearchPage, string | null>,
  readonly unknown[],
  string | null
>;

/** 온톨로지 화면 수명 안에서만 검색을 보관하며 자동 재시도·영구 저장은 사용하지 않습니다. */
export function createOntologyQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/** 토큰 대신 공개 연결·사용자·공간·관점·접근 판본으로 조회 키를 구분합니다. */
function scopeKey(scope: OntologyScope | null): readonly unknown[] {
  return [
    'ontology-exploration',
    scope?.connectionId,
    scope?.userId,
    scope?.tenant,
    scope?.profileId,
    scope?.accessRevision ?? scope?.policyRevision,
  ];
}

/** 서버 cursor를 사용해 검색별 페이지를 보관하며 다른 검색의 이전 결과는 섞지 않습니다. */
export function ontologySearchOptions(
  scope: OntologyScope | null,
  input: Omit<OntologySearchInput, 'cursor'>,
  onReadIndex?: (revision: string) => void,
): OntologySearchQueryOptions {
  return {
    queryKey: [...scopeKey(scope), 'search', input],
    initialPageParam: null,
    queryFn: async ({
      pageParam,
      signal,
    }: QueryFunctionContext<
      readonly unknown[],
      string | null
    >): Promise<OntologySearchPage> => {
      if (!scope)
        throw new OntologyQueryError({
          code: 'selection_required',
          message: '현재 작업 공간을 확인해 주세요.',
        });
      const result = await searchOntology(scope, {
        ...input,
        cursor: pageParam,
      });
      signal.throwIfAborted();
      if (!result.ok) throw new OntologyQueryError(result.error);
      onReadIndex?.(result.data.index_revision);
      return result.data;
    },
    getNextPageParam: (last: OntologySearchPage): string | null =>
      last.next_cursor,
  };
}

/** 관계는 매번 서버 판본을 확인하되 정확히 같은 진행 중 요청만 공유합니다. */
export async function queryOntologyNeighbors(
  client: QueryClient,
  scope: OntologyScope,
  input: OntologyNeighborsInput,
): Promise<OntologyOutcome<OntologyNeighborPage>> {
  try {
    const data = await client.query({
      queryKey: [...scopeKey(scope), 'neighbors', input],
      staleTime: 0,
      gcTime: 0,
      queryFn: async ({
        signal,
      }: QueryFunctionContext): Promise<OntologyNeighborPage> => {
        const result = await loadOntologyNeighbors(scope, input);
        signal.throwIfAborted();
        if (!result.ok) throw new OntologyQueryError(result.error);
        return result.data;
      },
    });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof OntologyQueryError
          ? error.failure
          : {
              code: 'query_cancelled',
              message:
                '조회가 변경되었습니다. 현재 화면에서 다시 시도해 주세요.',
            },
    };
  }
}
