import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import type {
  KnowledgeComparisonItem,
  KnowledgeComparisonDetail,
  KnowledgeComparisonLocal,
} from '@contracts/knowledgeComparisons.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  listComparisons,
  readComparison,
  restartComparison,
  stopComparison,
} from '../api/knowledgeComparisons.api';
import { readSessionScope, SessionScopeError } from '../api/aiSessions.api';

type ComparisonState = {
  items: KnowledgeComparisonItem[];
  selectedId: string | null;
  detail: KnowledgeComparisonDetail | null;
  local: KnowledgeComparisonLocal | null;
  incomplete: boolean;
  busy: boolean;
  error: string | null;
  reload: () => void;
  select: (id: string) => void;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
};

/** 이전 실행을 선택한 상태는 유지하며 실제 새 결과를 별도 선택할 수 있게 합니다. */
export function useKnowledgeComparisons(
  jobId: string | null,
  documentPath: string | null,
  initialComparisonId?: string | null,
  watch: boolean = false,
): ComparisonState {
  const active = useWorkspaceActivity();
  const [items, setItems] = useState<KnowledgeComparisonItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialComparisonId ?? null,
  );
  const [detail, setDetail] = useState<KnowledgeComparisonDetail | null>(null);
  const [local, setLocal] = useState<KnowledgeComparisonLocal | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useRef(initialComparisonId ?? null);
  const generation = useRef(0);
  const pending = useRef(false);
  const operation = useRef(false);
  const read = useCallback(
    async (quiet: boolean = false): Promise<void> => {
      if (!active || pending.current || operation.current) return;
      const serial = ++generation.current;
      pending.current = true;
      if (!quiet) setBusy(true);
      try {
        const scope = await readSessionScope();
        const page = await listComparisons({
          ...scope,
          jobId,
          document: documentPath,
          cursor: null,
        });
        const id = selected.current ?? page.latestId;
        const result = id
          ? await readComparison({ ...scope, comparisonId: id })
          : null;
        if (serial !== generation.current) return;
        setItems(page.items);
        setIncomplete(page.incomplete);
        selected.current = id;
        setSelectedId(id);
        setDetail(result?.comparison ?? null);
        setLocal(result?.local ?? null);
        setError(null);
      } catch (cause: unknown) {
        if (serial !== generation.current) return;
        if (cause instanceof SessionScopeError) {
          setItems([]);
          setDetail(null);
          setLocal(null);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : '기존 지식 대조를 읽지 못했습니다.',
        );
      } finally {
        if (serial === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [active, jobId, documentPath],
  );
  useEffect((): (() => void) => {
    generation.current += 1;
    pending.current = false;
    const serial = generation.current;
    queueMicrotask((): void => {
      if (serial === generation.current) void read();
    });
    const changed = (): void => {
      generation.current += 1;
      pending.current = false;
      selected.current = null;
      setSelectedId(null);
      setItems([]);
      setDetail(null);
      setLocal(null);
      setBusy(false);
      setError('연결이 변경되었습니다. 현재 작업 공간에서 다시 확인해 주세요.');
    };
    window.addEventListener('wiki-connection-changed', changed);
    return (): void => {
      generation.current += 1;
      pending.current = false;
      window.removeEventListener('wiki-connection-changed', changed);
    };
  }, [read]);
  const poll = useEffectEvent((): void => {
    void read(true);
  });
  useEffect((): (() => void) | undefined => {
    if (!active) return;
    // 짧은 후속 실행이 두 조회 사이에 끝나도 마지막 보관 결과를 한 번 더 읽습니다.
    let alive = true;
    queueMicrotask((): void => {
      if (alive) poll();
    });
    if (
      !watch &&
      detail?.status !== 'running' &&
      local?.status !== 'running' &&
      local?.status !== 'stopping' &&
      local?.status !== 'unconfirmed'
    )
      return (): void => {
        alive = false;
      };
    const timer = window.setInterval((): void => poll(), 2000);
    return (): void => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, detail?.status, local?.status, watch]);
  /** 조회·시작·중단 요청이 선택 전환과 섞이지 않도록 대상과 판본을 고정합니다. */
  async function act(kind: 'restart' | 'stop'): Promise<void> {
    if (!detail || pending.current || operation.current) return;
    const serial = ++generation.current;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const scope = await readSessionScope();
      const request = { ...scope, comparisonId: detail.record.id };
      const result =
        kind === 'restart'
          ? await restartComparison({
              ...request,
              expectedRevision: detail.revision,
            })
          : await stopComparison(request);
      if (serial !== generation.current) return;
      setDetail(result.comparison);
      setLocal(result.local);
    } catch (cause: unknown) {
      if (serial === generation.current) {
        if (cause instanceof SessionScopeError) {
          setItems([]);
          setDetail(null);
          setLocal(null);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : '대조 요청 결과를 확인하지 못했습니다.',
        );
      }
    } finally {
      operation.current = false;
      if (serial === generation.current) setBusy(false);
    }
  }
  return {
    items,
    selectedId,
    detail,
    local,
    incomplete,
    busy,
    error,
    reload: (): void => {
      void read();
    },
    select: (id: string): void => {
      if (pending.current || operation.current) return;
      selected.current = id;
      setSelectedId(id);
      setDetail(null);
      setLocal(null);
      void read();
    },
    restart: (): Promise<void> => act('restart'),
    stop: (): Promise<void> => act('stop'),
  };
}
