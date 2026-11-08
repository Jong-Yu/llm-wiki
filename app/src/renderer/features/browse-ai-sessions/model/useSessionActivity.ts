import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiActivity,
  AiSessionsSnapshot,
} from '@contracts/aiSessions.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  readSessionActivity,
  stopSessionActivity,
} from '../api/sessionActivity.api';
import { SessionScopeError } from '../api/aiSessions.api';

type ActivityState = {
  snapshot: AiSessionsSnapshot | null;
  error: string | null;
  busy: boolean;
  stopping: string | null;
  refresh: () => void;
  stop: (activity: AiActivity) => Promise<void>;
};

/** 화면 밖 실행은 main이 유지하며 이 hook은 활성 화면의 상태만 관찰합니다. */
export function useSessionActivity(
  connectionId?: string | null,
): ActivityState {
  const active = useWorkspaceActivity();
  const [snapshot, setSnapshot] = useState<AiSessionsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const lifetime = useRef(0);
  const stoppingRef = useRef(false);
  const [loadedConnection, setLoadedConnection] = useState(connectionId);
  const read = useCallback(
    async (refreshUsage: boolean): Promise<void> => {
      if (
        !active ||
        connectionId === null ||
        pending.current ||
        document.visibilityState === 'hidden'
      )
        return;
      const request = ++generation.current;
      pending.current = true;
      if (refreshUsage) setBusy(true);
      try {
        const result = await readSessionActivity(connectionId, refreshUsage);
        if (request !== generation.current) return;
        setSnapshot(result);
        setLoadedConnection(connectionId);
        setError(null);
      } catch (cause: unknown) {
        if (request !== generation.current) return;
        if (cause instanceof SessionScopeError) setSnapshot(null);
        setError(
          cause instanceof Error
            ? cause.message
            : '세션 상태를 읽지 못했습니다.',
        );
      } finally {
        if (request === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [active, connectionId],
  );
  useEffect((): (() => void) => {
    generation.current += 1;
    lifetime.current += 1;
    pending.current = false;
    const activation = generation.current;
    queueMicrotask((): void => {
      if (activation === generation.current) {
        setSnapshot(null);
        setError(null);
        setBusy(false);
        setStopping(null);
        stoppingRef.current = false;
        void read(false);
      }
    });
    const refresh = (): void => {
      void read(false);
    };
    const changed = (): void => {
      generation.current += 1;
      lifetime.current += 1;
      pending.current = false;
      setSnapshot(null);
      setError(null);
      setBusy(false);
      setStopping(null);
      stoppingRef.current = false;
      refresh();
    };
    const timer = window.setInterval(refresh, 2000);
    window.addEventListener('focus', refresh);
    window.addEventListener('wiki-connection-changed', changed);
    document.addEventListener('visibilitychange', refresh);
    return (): void => {
      generation.current += 1;
      lifetime.current += 1;
      pending.current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('wiki-connection-changed', changed);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [connectionId, read]);
  const stop = async (activity: AiActivity): Promise<void> => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const request = lifetime.current;
    setStopping(`${activity.kind}:${activity.id}`);
    setError(null);
    try {
      await stopSessionActivity(activity);
      if (request === lifetime.current) await read(false);
    } catch (cause: unknown) {
      if (request === lifetime.current) {
        if (cause instanceof SessionScopeError) setSnapshot(null);
        setError(
          cause instanceof Error
            ? cause.message
            : '중단 결과를 확인하지 못했습니다.',
        );
      }
    } finally {
      if (request === lifetime.current) {
        stoppingRef.current = false;
        setStopping(null);
      }
    }
  };
  return {
    snapshot: loadedConnection === connectionId ? snapshot : null,
    error,
    busy,
    stopping,
    refresh: (): void => {
      void read(true);
    },
    stop,
  };
}
