import { useEffect, useRef, useState } from 'react';
import type {
  ConnectRequest,
  ConnectionResult,
  ConnectionSnapshot,
  SelectWorkspaceRequest,
} from '@contracts/connection.contract';
import { connectionGateway } from '@renderer/platform/connection';

type ConnectionError = Extract<ConnectionResult, { ok: false }>['error'];
type PendingOperation =
  | 'restoring'
  | 'connecting'
  | 'selecting'
  | 'disconnecting'
  | 'retrying'
  | 'forgetting'
  | null;

type WorkspaceConnectionState = {
  snapshot: ConnectionSnapshot;
  pending: PendingOperation;
  error: ConnectionError | null;
  connect: (request: ConnectRequest) => Promise<void>;
  selectWorkspace: (request: SelectWorkspaceRequest) => Promise<void>;
  disconnect: () => Promise<void>;
  restoreSaved: () => Promise<void>;
  forgetSaved: () => Promise<void>;
};

const unavailable: ConnectionError = {
  code: 'bridge_unavailable',
  message: '연결 상태를 확인할 수 없습니다. 데스크톱 앱을 다시 열어 주세요.',
};

/** 비밀을 소유하지 않고 현재 main 연결의 공개 snapshot과 화면 요청 수명만 관리합니다. */
export function useWorkspaceConnection(): WorkspaceConnectionState {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>({
    status: 'disconnected',
  });
  const [pending, setPending] = useState<PendingOperation>('restoring');
  const [error, setError] = useState<ConnectionError | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);

  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    const current = (): boolean =>
      mounted.current && generation.current === request;
    void connectionGateway
      .getState()
      .then(
        (result: ConnectionResult): void => {
          if (!current()) return;
          if (result.ok) setSnapshot(result.data);
          else setError(result.error);
        },
        (): void => {
          if (current()) setError(unavailable);
        },
      )
      .finally((): void => {
        if (current()) setPending(null);
      });
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  /** 최신 요청의 응답만 반영하고 실패 시 main의 유효 연결을 복원합니다. */
  async function run(
    kind: Exclude<PendingOperation, null | 'restoring'>,
    operation: () => Promise<ConnectionResult>,
  ): Promise<void> {
    const request = ++generation.current;
    const current = (): boolean =>
      mounted.current && generation.current === request;
    setPending(kind);
    setError(null);
    try {
      const result = await operation();
      if (!current()) return;
      if (result.ok) setSnapshot(result.data);
      else {
        setError(result.error);
        // 실패한 새 입력과 main에 남은 이전 유효 연결을 분리해 표시합니다.
        const restored = await connectionGateway.getState();
        if (current() && restored.ok) setSnapshot(restored.data);
      }
    } catch {
      if (current()) setError(unavailable);
    } finally {
      if (current()) setPending(null);
    }
  }

  return {
    snapshot,
    pending,
    error,
    connect: (request: ConnectRequest): Promise<void> =>
      run('connecting', (): Promise<ConnectionResult> =>
        connectionGateway.connect(request),
      ),
    selectWorkspace: (request: SelectWorkspaceRequest): Promise<void> =>
      run('selecting', (): Promise<ConnectionResult> =>
        connectionGateway.selectWorkspace(request),
      ),
    disconnect: (): Promise<void> => {
      setSnapshot({ status: 'disconnected' });
      return run('disconnecting', (): Promise<ConnectionResult> =>
        connectionGateway.disconnect(),
      );
    },
    restoreSaved: (): Promise<void> =>
      run('retrying', (): Promise<ConnectionResult> =>
        connectionGateway.restoreSaved(),
      ),
    forgetSaved: (): Promise<void> =>
      run('forgetting', (): Promise<ConnectionResult> =>
        connectionGateway.forgetSaved(),
      ),
  };
}
