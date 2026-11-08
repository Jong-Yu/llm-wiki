import type { QueryFunctionContext } from '@tanstack/react-query';
import type { DocumentContent } from '@contracts/documents.contract';
import { ReadQueryError } from '@renderer/shared/lib/readQueries';
import type { ReadQueryCache } from '@renderer/shared/lib/readQueries';
import {
  readDocumentContent,
  readDocumentHistory,
  readHistoricalContent,
} from './documentContent.api';
import type {
  ContentResult,
  ContentSession,
  HistoryPage,
  HistoricalContent,
} from './documentContent.api';

type ContentQueryOptions = {
  queryKey: readonly unknown[];
  gcTime: number;
  queryFn: (context: QueryFunctionContext) => Promise<ContentSession>;
};

/** 조회 저장소와 편집 기준이 같은 가변 메타정보 객체를 공유하지 않도록 분리합니다. */
export function isolateContentSession(session: ContentSession): ContentSession {
  return structuredClone(session);
}

/** 본문 판본과 cursor/이력 ID가 같은 읽기만 공유하고 반환 객체는 호출자별로 분리합니다. */
async function queryVersion<T>(
  cache: ReadQueryCache,
  key: readonly unknown[],
  read: () => Promise<ContentResult<T>>,
  staleTime: number = 15_000,
): Promise<ContentResult<T>> {
  const failure = cache.getSnapshot().failure;
  if (failure) return { ok: false, error: failure };
  try {
    const value = await cache.client.query({
      queryKey: key,
      gcTime: 60_000,
      staleTime,
      queryFn: async (context: QueryFunctionContext): Promise<T> => {
        const result = await read();
        context.signal.throwIfAborted();
        if (!result.ok) throw new ReadQueryError(result.error);
        return result.data;
      },
    });
    return { ok: true, data: structuredClone(value) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ReadQueryError
          ? error.failure
          : {
              code: 'read_cancelled',
              message: '이력 조회가 변경되었습니다. 다시 확인해 주세요.',
            },
    };
  }
}

/** 이력 목록은 현재 본문 판본과 서버 cursor를 키로 사용합니다. */
export function queryDocumentHistory(
  cache: ReadQueryCache,
  current: DocumentContent,
  cursor: string | null,
): Promise<ContentResult<HistoryPage>> {
  return queryVersion(
    cache,
    cache.key('document-versions', current.document, current.revision, cursor),
    async (): Promise<ContentResult<HistoryPage>> => {
      const result = await readDocumentHistory(current, cursor);
      if (result.ok && result.data.current.revision !== current.revision)
        return {
          ok: false,
          error: {
            code: 'catalog_changed',
            message:
              '현재 본문이 변경되었습니다. 본문을 다시 확인한 뒤 이력을 읽어 주세요.',
          },
        };
      return result;
    },
    0,
  );
}

/** 선택한 과거 전체 파일은 이력 ID를 유지하며 복원 명령과 분리합니다. */
export function queryHistoricalContent(
  cache: ReadQueryCache,
  current: DocumentContent,
  historyId: string,
): Promise<ContentResult<HistoricalContent>> {
  return queryVersion(
    cache,
    cache.key(
      'document-version',
      current.document,
      current.revision,
      historyId,
    ),
    (): Promise<ContentResult<HistoricalContent>> =>
      readHistoricalContent(current, historyId),
  );
}

/** 문서 본문은 허용 세션·정확한 경로별로 보관하고 초안/CAS 기준과 공유하지 않습니다. */
export function documentContentOptions(
  cache: ReadQueryCache,
  path: string,
  expected?: DocumentContent,
): ContentQueryOptions {
  return {
    queryKey: cache.key('document-content', path),
    gcTime: 60_000,
    queryFn: async (context: QueryFunctionContext): Promise<ContentSession> => {
      const result = await readDocumentContent(path, expected);
      context.signal.throwIfAborted();
      if (!result.ok) throw new ReadQueryError(result.error);
      return result.data;
    },
  };
}

/** 비교·새 판본 확인은 항상 서버에서 읽되 동시에 진행 중인 동일 읽기만 공유합니다. */
export async function queryCurrentContent(
  cache: ReadQueryCache,
  path: string,
  expected?: DocumentContent,
): Promise<ContentResult<ContentSession>> {
  const failure = cache.getSnapshot().failure;
  if (failure) return { ok: false, error: failure };
  try {
    const data = await cache.client.query({
      ...documentContentOptions(cache, path, expected),
      staleTime: 0,
    });
    return { ok: true, data: isolateContentSession(data) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ReadQueryError
          ? error.failure
          : {
              code: 'read_cancelled',
              message: '현재 문서 조회가 변경되었습니다. 다시 확인해 주세요.',
            },
    };
  }
}
