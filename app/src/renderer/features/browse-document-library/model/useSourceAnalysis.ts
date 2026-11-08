import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { notifyReadChange } from '@renderer/shared/lib/readQueries';
import {
  readSourceAnalysisIndex,
  sourceAnalysisKey,
} from '../api/sourceAnalysis.api';
import type {
  SourceAnalysisStarter,
  LibrarySourceItem,
} from './documentLibrary.types';
import type {
  SourceAnalysis,
  SourceAnalysisIndex,
  SourceAnalysisKind,
} from '../api/sourceAnalysis.api';

/** 행에 표시할 상태입니다. unknown은 작업 목록을 모두 읽지 못해 "분석 전"을 단정할 수 없는 경우입니다. */
export type SourceAnalysisView = {
  kind: SourceAnalysisKind | 'unknown';
  jobId: string | null;
};
type SourceAnalysisModel = {
  viewOf: (item: LibrarySourceItem) => SourceAnalysisView;
  start: (item: LibrarySourceItem) => Promise<void>;
  message: string | null;
};

const pollMs = 4000;

/**
 * 원본 판본별 분석 상태를 서버 작업 목록에서 읽고, "분석 시작"으로 변환→접수→AI 추출을 바로 시작합니다.
 * 같은 판본의 작업이 이미 있으면(서버 기준 재확인) 새로 시작하지 않고 그 작업을 보여 줍니다.
 */
export function useSourceAnalysis(
  connectionId: string | null,
  items: readonly LibrarySourceItem[],
  starter: SourceAnalysisStarter,
): SourceAnalysisModel {
  const active = useWorkspaceActivity();
  const [index, setIndex] = useState<SourceAnalysisIndex | null>(null);
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);
  const indexFingerprint = useRef<string | null>(null);
  const itemsRef = useRef(items);
  useEffect((): void => {
    itemsRef.current = items;
  }, [items]);
  const load = useCallback(async (): Promise<void> => {
    // 여러 페이지 조회가 주기보다 오래 걸려도 같은 목록 요청을 겹쳐 보내지 않습니다.
    if (!connectionId || pending.current !== null) return;
    const request = ++generation.current;
    pending.current = request;
    try {
      const next = await readSourceAnalysisIndex(connectionId);
      if (request !== generation.current) return;
      const fingerprint = JSON.stringify([next.complete, [...next.bySource]]);
      if (
        indexFingerprint.current !== null &&
        indexFingerprint.current !== fingerprint
      )
        notifyReadChange();
      indexFingerprint.current = fingerprint;
      setIndex(next);
      setInFlight(itemsRef.current.some(starter.inFlight));
    } catch {
      // 상태를 읽지 못해도 목록은 그대로 두고 이전에 읽은 상태를 유지합니다.
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, [connectionId, starter]);
  useEffect((): (() => void) => {
    generation.current += 1;
    pending.current = null;
    const reset = (): void => {
      setIndex(null);
      indexFingerprint.current = null;
      setMessage(null);
    };
    const changed = (): void => {
      generation.current += 1;
      pending.current = null;
      reset();
    };
    // 연결·공간이 바뀌면 이전 범위의 상태를 먼저 숨깁니다.
    queueMicrotask(reset);
    window.addEventListener('wiki-connection-changed', changed);
    return (): void => {
      generation.current += 1;
      pending.current = null;
      window.removeEventListener('wiki-connection-changed', changed);
    };
  }, [connectionId]);
  const hasItems = items.length > 0;
  useEffect((): void => {
    if (!active || !connectionId || !hasItems) return;
    queueMicrotask((): void => {
      void load();
    });
  }, [active, connectionId, hasItems, load]);
  const polling =
    active &&
    !!connectionId &&
    (starting.size > 0 ||
      inFlight ||
      [...(index?.bySource.values() ?? [])].some(
        (entry: SourceAnalysis): boolean =>
          entry.kind === 'running' || entry.kind === 'pending',
      ));
  useEffect((): (() => void) | undefined => {
    if (!polling) return;
    const timer = window.setInterval((): void => {
      void load();
    }, pollMs);
    return (): void => window.clearInterval(timer);
  }, [polling, load]);

  const start = async (item: LibrarySourceItem): Promise<void> => {
    if (!connectionId) return;
    const key = sourceAnalysisKey(item.sourceId, item.sourceVersion);
    if (starting.has(key) || starter.inFlight(item)) return;
    setMessage(null);
    setStarting((current: ReadonlySet<string>): ReadonlySet<string> =>
      new Set(current).add(key),
    );
    try {
      // 목록이 오래됐을 수 있어 시작 직전에 서버 작업을 다시 읽고 중복 접수를 막습니다.
      const fresh = await readSourceAnalysisIndex(connectionId);
      if (fresh.bySource.has(key)) {
        setIndex(fresh);
        setMessage(
          '이 버전은 이미 분석 작업이 있어 새로 시작하지 않았습니다. 작업 보기에서 확인해 주세요.',
        );
        return;
      }
      if (!fresh.complete) {
        setMessage(
          '분석 작업 목록을 모두 확인하지 못해 시작하지 않았습니다. 잠시 뒤 다시 시도해 주세요.',
        );
        return;
      }
      const result = await starter.start(item);
      if (!result.ok) setMessage(result.message);
    } catch {
      setMessage(
        '분석을 시작한 결과를 확인하지 못했습니다. 작업 보기에서 상태를 확인해 주세요.',
      );
    } finally {
      setStarting((current: ReadonlySet<string>): ReadonlySet<string> => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      void load();
    }
  };

  const viewOf = (item: LibrarySourceItem): SourceAnalysisView => {
    const key = sourceAnalysisKey(item.sourceId, item.sourceVersion);
    const entry = index?.bySource.get(key);
    if (starting.has(key) || starter.inFlight(item))
      return { kind: 'running', jobId: entry?.jobId ?? null };
    if (entry) return { kind: entry.kind, jobId: entry.jobId };
    return { kind: index?.complete ? 'none' : 'unknown', jobId: null };
  };
  return { viewOf, start, message };
}
