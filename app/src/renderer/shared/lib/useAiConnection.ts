import { useSyncExternalStore } from 'react';

export type AiConnectionStatus =
  | 'checking'
  | 'connected'
  | 'required'
  | 'unknown';
export type AiConnectionLevel =
  | 'verified'
  | 'login'
  | 'required'
  | 'error'
  | 'waiting'
  | 'checking'
  | 'unknown';

/** shared에서 런타임 계약 전체를 참조하지 않고 표시할 필드만 받습니다. */
export type AiConnectionProbe = {
  settings: { provider: string };
  cliConnection?: {
    provider: string;
    status: string;
    verifiedAt?: string | null;
  };
  activeProvider?: string;
  activeModel?: string;
};
type ConnectionState = {
  level: AiConnectionLevel;
  status: AiConnectionStatus;
  provider: string | null;
  model: string | null;
};
type ConnectionHook<T extends AiConnectionProbe> = {
  (): ConnectionState;
  useSnapshot: () => T | null;
  readSnapshot: () => Promise<T>;
  update: (snapshot: T) => void;
};
type AiConnectionPresentation = {
  word: string;
  tone: 'ok' | 'info' | 'warn' | 'bad';
};
const MIN_RECHECK_MS = 5000;

/** 선택한 AI의 연결 기록이 없으면 기존 호출자가 실행할 수 있도록 미확인 상태를 유지합니다. */
export function levelFromSnapshot(
  snapshot: AiConnectionProbe,
): AiConnectionLevel {
  const connection = snapshot.cliConnection;
  if (
    !snapshot.settings.provider ||
    !connection ||
    connection.provider !== snapshot.settings.provider
  )
    return 'unknown';
  switch (connection.status) {
    case 'connected':
      return connection.verifiedAt ? 'verified' : 'login';
    case 'waiting_login':
      return 'waiting';
    case 'checking':
      return 'checking';
    case 'error':
      return 'error';
    case 'idle':
    case 'login_required':
      return 'required';
    default:
      return 'unknown';
  }
}

/** 채팅과 전역 헤더에서 같은 연결 문구와 색을 사용합니다. */
export function getAiConnectionPresentation(
  level: AiConnectionLevel,
  provider: string,
): AiConnectionPresentation {
  switch (level) {
    case 'verified':
      return { word: `${provider} 연결됨`, tone: 'ok' };
    case 'login':
      return { word: `${provider} 로그인만 확인`, tone: 'info' };
    case 'required':
      return { word: 'AI 연결 필요', tone: 'warn' };
    case 'error':
      return { word: 'AI 오류', tone: 'bad' };
    case 'waiting':
      return { word: '로그인 대기 중', tone: 'warn' };
    case 'checking':
      return { word: '연결 확인 중', tone: 'info' };
    case 'unknown':
      return { word: '상태 확인 필요', tone: 'warn' };
  }
}

/** 기존 실행 버튼은 확인된 로그인과 실제 호출 성공을 모두 사용할 수 있습니다. */
function statusOfLevel(level: AiConnectionLevel): AiConnectionStatus {
  if (level === 'verified' || level === 'login') return 'connected';
  if (level === 'waiting' || level === 'error') return 'required';
  return level;
}

/** 읽기 결과는 구독자가 공유하고 설정 명령의 결과는 다음 창 포커스까지 기다리지 않고 반영합니다. */
export function createUseAiConnection<T extends AiConnectionProbe>(
  read: () => Promise<T>,
): ConnectionHook<T> {
  let current: ConnectionState = {
    level: 'checking',
    status: 'checking',
    provider: null,
    model: null,
  };
  let lastChecked = 0;
  let version = 0;
  let inFlight: Promise<T> | null = null;
  let latest: T | null = null;
  const listeners = new Set<() => void>();

  /** 원본과 표시 상태를 함께 발행합니다. 표시값이 같으면 헤더는 기존 참조를 유지합니다. */
  function publish(snapshot: T | null): void {
    version++;
    lastChecked = Date.now();
    latest = snapshot;
    const level = snapshot ? levelFromSnapshot(snapshot) : 'unknown';
    const provider = snapshot?.settings.provider ?? null;
    const model =
      snapshot?.activeProvider === provider
        ? (snapshot.activeModel ?? null)
        : null;
    if (
      current.level !== level ||
      current.provider !== provider ||
      current.model !== model
    ) {
      current = { level, status: statusOfLevel(level), provider, model };
    }
    // 연결 단계가 같아도 경로·진단·저장 여부가 바뀐 원본을 구독자에게 알립니다.
    for (const listener of listeners) listener();
  }

  /** 설정과 헤더가 동시에 열려도 같은 조회를 사용하고, 그 사이 완료된 설정 변경을 우선합니다. */
  function readSnapshot(): Promise<T> {
    if (inFlight) return inFlight;
    const started = version;
    inFlight = read()
      .then(
        (snapshot: T): T => {
          if (version !== started && latest !== null) return latest;
          publish(snapshot);
          return snapshot;
        },
        (cause: unknown): T => {
          if (version !== started && latest !== null) return latest;
          publish(null);
          throw cause;
        },
      )
      .finally((): void => {
        inFlight = null;
      });
    return inFlight;
  }

  /** 창 포커스로 인한 재조회는 간격을 제한합니다. 실패 상태는 읽기 함수가 이미 전달합니다. */
  function check(): void {
    if (Date.now() - lastChecked >= MIN_RECHECK_MS)
      void readSnapshot().catch((): void => {});
  }

  /** 구독자가 없을 때는 창의 조회 이벤트도 해제합니다. */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) {
      window.addEventListener('focus', check);
      check();
    }
    return (): void => {
      listeners.delete(listener);
      if (listeners.size === 0) window.removeEventListener('focus', check);
    };
  }

  /** 현재 연결 상태의 안정된 참조를 반환합니다. */
  function getSnapshot(): ConnectionState {
    return current;
  }

  /** 선택한 AI의 로그인·호출 확인 결과를 구독합니다. */
  function useAiConnection(): ConnectionState {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  /** 마지막으로 확인한 전체 런타임입니다. 첫 조회 전과 최신 조회 실패 시에는 null입니다. */
  function getRawSnapshot(): T | null {
    return latest;
  }

  /** 설정 명령, 진단, 재조회로 갱신되는 전체 런타임을 같은 저장소에서 구독합니다. */
  function useSnapshot(): T | null {
    return useSyncExternalStore(subscribe, getRawSnapshot, getRawSnapshot);
  }
  return Object.assign(useAiConnection, {
    useSnapshot,
    readSnapshot,
    update: publish,
  });
}
