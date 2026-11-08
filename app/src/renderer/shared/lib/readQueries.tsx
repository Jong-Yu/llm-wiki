import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { JSX, ReactNode } from 'react';
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';

export type ReadFailure = { code: string; message: string; status?: number };

/** 명시 접근 오류만 이전 조회 자료를 폐기하는 오류로 구분합니다. */
export function invalidatesReadScope(failure: ReadFailure): boolean {
  return (
    failure.status === 401 ||
    failure.status === 403 ||
    [
      'scope_changed',
      'connection_changed',
      'subject_changed',
      'access_changed',
      'policy_changed',
      'forbidden',
      'unauthorized',
      'not_connected',
      'connection_required',
      'selection_required',
      'access_denied',
      'access_unavailable',
    ].includes(failure.code)
  );
}

/** 실패 봉투를 성공 데이터로 캐시하지 않고 공개 오류 정보만 전달합니다. */
export class ReadQueryError extends Error {
  readonly failure: ReadFailure;
  constructor(failure: ReadFailure) {
    super(failure.message);
    this.name = 'ReadQueryError';
    this.failure = failure;
  }
}

type ReadSnapshot = { generation: number; failure: ReadFailure | null };

/** 한 공개 세션 식별자에만 속한 읽기 저장소이며 인증 비밀·쓰기 요청을 보관하지 않습니다. */
export class ReadQueryCache {
  readonly client: QueryClient;
  readonly identity: string;
  private snapshot: ReadSnapshot = { generation: 0, failure: null };
  private listeners = new Set<() => void>();
  private lifetime = 0;
  constructor(identity: string) {
    this.identity = identity;
    this.client = new QueryClient({
      queryCache: new QueryCache({
        onError: (error: Error): void => {
          if (
            error instanceof ReadQueryError &&
            invalidatesReadScope(error.failure)
          )
            this.deny(error.failure);
        },
      }),
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
  getSnapshot = (): ReadSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  };
  /** 접근 오류는 모든 읽기 캐시를 비우고 명시 재조회 전에는 자동 호출하지 않습니다. */
  deny = (failure: ReadFailure): void => {
    if (this.snapshot.failure) return;
    this.client.clear();
    this.snapshot = { generation: this.snapshot.generation + 1, failure };
    this.listeners.forEach((listener: () => void): void => listener());
  };
  /** 연결 변경·명시 재조회는 이전 응답을 취소하고 새 세대에서 시작합니다. */
  clear = (): void => {
    this.client.clear();
    this.snapshot = { generation: this.snapshot.generation + 1, failure: null };
    this.listeners.forEach((listener: () => void): void => listener());
  };
  key = (
    resource: string,
    ...parameters: readonly unknown[]
  ): readonly unknown[] => [
    'workspace-read',
    this.identity,
    this.snapshot.generation,
    resource,
    ...parameters,
  ];
  /** 자료 변경 후 활성 읽기만 갱신하며 쓰기·초안 기준은 실행하지 않습니다. */
  invalidate = (): void => {
    void this.client.invalidateQueries();
  };
  /** 포커스 복귀는 이미 진행 중인 읽기를 취소하지 않고 공유합니다. */
  refresh = (): void => {
    void this.client.invalidateQueries({}, { cancelRefetch: false });
  };
  /** StrictMode의 정리/재연결과 실제 화면 트리 종료를 구분합니다. */
  beginUse = (): number => ++this.lifetime;
  endUse = (lease: number): void => {
    queueMicrotask((): void => {
      if (lease === this.lifetime) this.client.clear();
    });
  };
}

const ReadContext = createContext<ReadQueryCache | null>(null);
type ReadQueriesProviderProps = { identity: string; children: ReactNode };

/** 인증된 화면 트리와 같은 수명으로 자료를 보관하고 연결 변경 시 즉시 폐기합니다. */
export function ReadQueriesProvider({
  identity,
  children,
}: ReadQueriesProviderProps): JSX.Element {
  const [cache] = useState((): ReadQueryCache => new ReadQueryCache(identity));
  useEffect((): (() => void) => {
    const lease = cache.beginUse();
    window.addEventListener('wiki-connection-changed', cache.clear);
    window.addEventListener('wiki-data-changed', cache.invalidate);
    const focus = (): void => cache.refresh();
    window.addEventListener('focus', focus);
    return (): void => {
      window.removeEventListener('wiki-connection-changed', cache.clear);
      window.removeEventListener('wiki-data-changed', cache.invalidate);
      window.removeEventListener('focus', focus);
      cache.endUse(lease);
    };
  }, [cache]);
  return (
    <ReadContext value={cache}>
      <QueryClientProvider client={cache.client}>
        {children}
      </QueryClientProvider>
    </ReadContext>
  );
}

/** 외부 저장소의 접근 실패·세대 변경을 같은 렌더에서 구독합니다. */
export function useReadQueries(): {
  cache: ReadQueryCache;
  snapshot: ReadSnapshot;
} {
  const cache = useContext(ReadContext);
  if (!cache) throw new Error('ReadQueriesProvider is required');
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  return { cache, snapshot };
}

/** 확인한 자료 변경은 조회를 무효화할 뿐 저장을 자동 재시도하지 않습니다. */
export function notifyReadChange(): void {
  if (
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function'
  )
    window.dispatchEvent(new Event('wiki-data-changed'));
}
