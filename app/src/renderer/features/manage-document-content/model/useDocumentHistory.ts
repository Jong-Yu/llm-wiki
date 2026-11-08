import { useEffect, useRef, useState } from 'react';
import type { DocumentContent } from '@contracts/documents.contract';
import { useReadQueries } from '@renderer/shared/lib/readQueries';
import {
  queryDocumentHistory,
  queryHistoricalContent,
} from '../api/documentContent.queries';
import type {
  ContentFailure,
  HistoryPage,
  HistoricalContent,
} from '../api/documentContent.api';

/** 선택한 버전의 바로 앞 버전 본문: 없음(첫 버전)과 불러오지 못함을 구분합니다. */
export type PreviousVersion =
  | { status: 'content'; content: string }
  | { status: 'none' }
  | { status: 'unavailable' };
export type DocumentHistoryModel = {
  page: HistoryPage | null;
  selected: HistoricalContent | null;
  previous: PreviousVersion | null;
  busy: boolean;
  error: ContentFailure | null;
  load: (cursor: string | null) => Promise<void>;
  select: (historyId: string) => Promise<void>;
};
type HistoryInput = { current: DocumentContent; onInvalidated: () => void };
/** 목록과 선택 전체 본문을 개별 조회하며 늦은 판본 응답을 버립니다. */
export function useDocumentHistory({
  current,
  onInvalidated,
}: HistoryInput): DocumentHistoryModel {
  const { cache } = useReadQueries();
  const readDocumentHistory = (
    value: DocumentContent,
    cursor: string | null,
  ): ReturnType<typeof queryDocumentHistory> =>
    queryDocumentHistory(cache, value, cursor);
  const readHistoricalContent = (
    value: DocumentContent,
    historyId: string,
  ): ReturnType<typeof queryHistoricalContent> =>
    queryHistoricalContent(cache, value, historyId);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [selected, setSelected] = useState<HistoricalContent | null>(null);
  const [previous, setPrevious] = useState<PreviousVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ContentFailure | null>(null);
  const alive = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect((): (() => void) => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  /** 권한 거부 시 이전 이력도 표시하지 않습니다. */
  function fail(value: ContentFailure): void {
    setError(value);
    if (
      value.status === 401 ||
      value.status === 403 ||
      value.code === 'scope_changed'
    )
      onInvalidated();
  }
  /** cursor와 카탈로그 기준이 같을 때만 다음 이력을 누적합니다. */
  async function load(cursor: string | null): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    if (cursor === null) {
      setSelected(null);
      setPrevious(null);
    }
    const result = await readDocumentHistory(current, cursor);
    if (!alive.current || request !== generation.current) return;
    pending.current = false;
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    if (
      cursor &&
      page &&
      page.catalog_revision !== result.data.catalog_revision
    ) {
      setError({
        code: 'history_changed',
        message: '이력 목록이 바뀌었습니다. 처음부터 다시 조회해 주세요.',
      });
      return;
    }
    setPage(
      cursor && page
        ? { ...result.data, items: [...page.items, ...result.data.items] }
        : result.data,
    );
  }
  /** 선택 버전과 바로 앞 버전을 함께 읽으며 실패는 목록과 현재 본문을 바꾸지 않습니다. */
  async function select(historyId: string): Promise<void> {
    // 뒤로가기에서 다른 버전을 선택하면 이전 조회의 늦은 응답을 무시합니다.
    const request = ++generation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    setSelected(null);
    setPrevious(null);
    const items = page?.items ?? [];
    const index = items.findIndex(
      (item: (typeof items)[number]): boolean => item.history_id === historyId,
    );
    const older = index >= 0 ? items[index + 1] : undefined;
    const [result, olderResult] = await Promise.all([
      readHistoricalContent(current, historyId),
      older ? readHistoricalContent(current, older.history_id) : null,
    ]);
    if (!alive.current || request !== generation.current) return;
    pending.current = false;
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setSelected(result.data);
    // 더 오래된 이력이 아직 목록에 없으면 첫 버전으로 단정하지 않습니다.
    setPrevious(
      olderResult
        ? olderResult.ok
          ? { status: 'content', content: olderResult.data.content }
          : { status: 'unavailable' }
        : page?.next_cursor || index < 0
          ? { status: 'unavailable' }
          : { status: 'none' },
    );
  }
  return { page, selected, previous, busy, error, load, select };
}
