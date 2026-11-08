import { useEffect, useRef, useState } from 'react';
import type {
  AccountRequest,
  ConnectionResult,
  ConnectionSnapshot,
  SelectWorkspaceRequest,
} from '@contracts/connection.contract';
import type {
  RuntimeRequest,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import {
  connectToolsServer,
  disconnectToolsServer,
  readToolsConnection,
  requestToolsRuntime,
  restoreToolsConnection,
  selectToolsWorkspace,
} from '../api/workspaceTools.api';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { describeToolsConnectionFailure } from './workspaceToolsState';
import type { ToolsFailure } from './workspaceToolsState';

type ConnectionOperation =
  | 'read'
  | 'connect'
  | 'select'
  | 'restore'
  | 'disconnect';
type WorkspaceToolsState = {
  connection: ConnectionSnapshot | null;
  connectionPending: ConnectionOperation | null;
  connectionError: ToolsFailure | null;
  clearConnectionError: () => void;
  runtime: RuntimeSnapshot | null;
  runtimePending: RuntimeRequest['operation'] | null;
  runtimeError: ToolsFailure | null;
  connect: (request: AccountRequest) => Promise<void>;
  select: (request: SelectWorkspaceRequest) => Promise<void>;
  refresh: () => Promise<void>;
  restore: () => Promise<void>;
  disconnect: () => Promise<void>;
  runRuntime: (request: RuntimeRequest) => Promise<void>;
};

/** 두 독립 연결의 요청을 직렬화하고 화면을 떠난 뒤 도착하는 결과를 버립니다. 비밀은 상태에 보관하지 않습니다. */
export function useWorkspaceTools(
  includeRuntime: boolean = true,
): WorkspaceToolsState {
  const [connection, setConnection] = useState<ConnectionSnapshot | null>(null);
  const [connectionPending, setConnectionPending] =
    useState<ConnectionOperation | null>('read');
  const [connectionError, setConnectionError] = useState<ToolsFailure | null>(
    null,
  );
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [runtimePending, setRuntimePending] = useState<
    RuntimeRequest['operation'] | null
  >('read');
  const [runtimeError, setRuntimeError] = useState<ToolsFailure | null>(null);
  const generation = useRef(0);
  const connectionBusy = useRef(true);
  const runtimeBusy = useRef(true);
  const runtimeRequestVersion = useRef(0);
  const loginStatus = runtime?.cliConnection?.status;
  const loginProvider = runtime?.settings.provider;

  useEffect((): (() => void) => {
    const request = ++generation.current;
    const current = (): boolean => generation.current === request;
    void readToolsConnection()
      .then(
        (result: ConnectionResult): void => {
          if (!current()) return;
          if (result.ok) setConnection(result.data);
          else setConnectionError(describeToolsConnectionFailure(result.error));
        },
        (): void => {
          if (current())
            setConnectionError({
              title: '연결 상태를 읽지 못했습니다',
              detail: '데스크톱 앱의 연결 상태를 다시 확인해 주세요.',
            });
        },
      )
      .finally((): void => {
        if (current()) {
          connectionBusy.current = false;
          setConnectionPending(null);
        }
      });
    if (includeRuntime)
      void useAiConnection
        .readSnapshot()
        .then(
          (result: RuntimeSnapshot): void => {
            if (current()) setRuntime(result);
          },
          (): void => {
            if (current())
              setRuntimeError({
                title: '실행 환경을 읽지 못했습니다',
                detail: '다시 읽기를 눌러 현재 설정을 확인해 주세요.',
              });
          },
        )
        .finally((): void => {
          if (current()) {
            runtimeBusy.current = false;
            setRuntimePending(null);
          }
        });
    const changed = (): void => {
      void readToolsConnection()
        .then((result: ConnectionResult): void => {
          if (current() && result.ok) setConnection(result.data);
        })
        .catch((): void => {});
    };
    window.addEventListener('wiki-connection-changed', changed);
    return (): void => {
      generation.current += 1;
      window.removeEventListener('wiki-connection-changed', changed);
    };
  }, [includeRuntime]);

  useEffect((): (() => void) | undefined => {
    if (loginStatus !== 'waiting_login' && loginStatus !== 'checking') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifecycle = generation.current;
    /** main의 로그인 진행만 읽고 사용자 명령 뒤에 도착한 이전 응답은 버립니다. */
    async function poll(): Promise<void> {
      const version = runtimeRequestVersion.current;
      if (!runtimeBusy.current) {
        try {
          const result = await useAiConnection.readSnapshot();
          if (
            !disposed &&
            generation.current === lifecycle &&
            runtimeRequestVersion.current === version &&
            result.settings.provider === loginProvider
          ) {
            setRuntime(result);
          }
        } catch {
          if (
            !disposed &&
            generation.current === lifecycle &&
            runtimeRequestVersion.current === version
          )
            setRuntimeError({
              title: '로그인 상태를 새로 읽지 못했습니다',
              detail:
                '터미널에서 로그인한 뒤 ‘로그인 완료 확인’을 눌러 주세요.',
            });
        }
      }
      if (!disposed)
        timer = setTimeout((): void => {
          void poll();
        }, 2000);
    }
    timer = setTimeout((): void => {
      void poll();
    }, 2000);
    return (): void => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [loginStatus, loginProvider]);

  /** 실패 후 main 상태를 다시 읽되 실패한 주소 초안을 성공 상태로 대체하지 않습니다. */
  async function runConnection(
    operation: ConnectionOperation,
    execute: () => Promise<ConnectionResult>,
  ): Promise<void> {
    if (connectionBusy.current) return;
    connectionBusy.current = true;
    const request = generation.current;
    const current = (): boolean => generation.current === request;
    setConnectionPending(operation);
    setConnectionError(null);
    try {
      const result = await execute();
      if (!current()) return;
      if (result.ok) setConnection(result.data);
      else {
        setConnectionError(describeToolsConnectionFailure(result.error));
        const latest = await readToolsConnection();
        if (current() && latest.ok) setConnection(latest.data);
      }
    } catch {
      if (current())
        setConnectionError({
          title: '연결 결과를 확인하지 못했습니다',
          detail: '‘연결 다시 확인’을 눌러 주세요.',
        });
    } finally {
      if (current()) {
        connectionBusy.current = false;
        setConnectionPending(null);
      }
    }
  }

  /** 저장 오류와 진단 실패를 분리하고 선택한 경로·제공자를 실패 후에도 보존합니다. */
  async function runRuntime(request: RuntimeRequest): Promise<void> {
    if (runtimeBusy.current) return;
    runtimeBusy.current = true;
    runtimeRequestVersion.current += 1;
    const version = generation.current;
    const current = (): boolean => generation.current === version;
    setRuntimePending(request.operation);
    setRuntimeError(null);
    try {
      const result =
        request.operation === 'read'
          ? await useAiConnection.readSnapshot()
          : await requestToolsRuntime(request);
      if (request.operation !== 'read') useAiConnection.update(result);
      if (current()) setRuntime(result);
    } catch (failure: unknown) {
      if (current())
        setRuntimeError({
          title:
            request.operation === 'save'
              ? '설정을 저장하지 못했습니다'
              : request.operation === 'connect-cli' ||
                  request.operation === 'check-cli-login'
                ? 'AI 연결을 완료하지 못했습니다'
                : request.operation === 'diagnose'
                  ? 'CLI 준비 상태를 확인하지 못했습니다'
                  : '실행 환경 요청을 완료하지 못했습니다',
          detail:
            failure instanceof Error
              ? failure.message
              : request.operation === 'save'
                ? '선택한 CLI와 경로는 유지됩니다. 실행 환경 경로와 저장소 상태를 확인한 뒤 다시 저장해 주세요.'
                : '현재 선택은 유지됩니다. 경로와 설치 상태를 확인한 뒤 다시 시도해 주세요.',
        });
    } finally {
      if (current()) {
        runtimeBusy.current = false;
        setRuntimePending(null);
      }
    }
  }

  return {
    connection,
    connectionPending,
    connectionError,
    clearConnectionError: (): void => {
      if (!connectionBusy.current) setConnectionError(null);
    },
    runtime,
    runtimePending,
    runtimeError,
    connect: (request: AccountRequest): Promise<void> =>
      runConnection('connect', (): Promise<ConnectionResult> =>
        connectToolsServer(request),
      ),
    select: (request: SelectWorkspaceRequest): Promise<void> =>
      runConnection('select', (): Promise<ConnectionResult> =>
        selectToolsWorkspace(request),
      ),
    refresh: (): Promise<void> => runConnection('read', readToolsConnection),
    restore: (): Promise<void> =>
      runConnection('restore', restoreToolsConnection),
    disconnect: (): Promise<void> =>
      runConnection('disconnect', disconnectToolsServer),
    runRuntime,
  };
}
