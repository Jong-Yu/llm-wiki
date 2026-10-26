import { useEffect, useRef, useState } from 'react';
import type { DocumentContent } from '@contracts/documents.contract';
import {
  loadDocumentVersions,
  loadDocumentVersion,
  loadCurrentDocument,
  restoreDocumentVersion,
} from '../api/documentHistory.api';
import type {
  DocumentHistoryInput,
  DocumentHistoryPage,
  HistoricalDocument,
  DocumentRestoreOutcome,
  HistoryFailure,
  HistoryResult,
} from '../api/documentHistory.api';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: HistoryFailure }
  | { status: 'ready'; page: DocumentHistoryPage };
type SelectedState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: HistoryFailure }
  | { status: 'ready'; old: HistoricalDocument; current: DocumentContent };
type HistoryModelInput = DocumentHistoryInput & {
  onRestored: (outcome: DocumentRestoreOutcome) => void;
  onScopeInvalidated: () => void;
};
export type DocumentHistoryModel = {
  list: ListState;
  selected: SelectedState;
  pageNumber: number;
  canPrevious: boolean;
  busy: boolean;
  conflict: boolean;
  uncertain: boolean;
  restored: DocumentRestoreOutcome | null;
  error: HistoryFailure | null;
  reload: () => void;
  next: () => void;
  previous: () => void;
  select: (historyId: string) => void;
  compareCurrent: () => void;
  restore: () => Promise<void>;
};
const unconfirmedRestorations = new Set<string>();

/** 다른 문서/관점의 미확정 복원과 조회 상태가 섞이지 않게 합니다. */
function inputKey(input: DocumentHistoryInput): string {
  return JSON.stringify([
    input.connectionId,
    input.scope.userId,
    input.scope.tenant,
    input.scope.profileId,
    input.scope.policyRevision,
    input.document,
  ]);
}

/** 이력 페이지·전체 본문 비교·명시 복원의 수명을 분리합니다. */
export function useDocumentHistory(
  input: HistoryModelInput,
): DocumentHistoryModel {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState<SelectedState>({ status: 'idle' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(
    unconfirmedRestorations.has(inputKey(input)),
  );
  const [restored, setRestored] = useState<DocumentRestoreOutcome | null>(null);
  const [error, setError] = useState<HistoryFailure | null>(null);
  const mounted = useRef(false);
  const listGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const locked = useRef(false);
  const initialInput = useRef(input);
  const key = inputKey(input);

  /** 접근 범위 변경은 부모가 이전 자료를 숨기도록 전달합니다. */
  function failure(error: HistoryFailure): void {
    if (
      error.status === 401 ||
      error.status === 403 ||
      ['scope_changed', 'connection_changed', 'subject_changed'].includes(
        error.code,
      )
    )
      input.onScopeInvalidated();
  }
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++listGeneration.current;
    const initial = initialInput.current;
    void loadDocumentVersions(initial, null).then(
      (result: HistoryResult<DocumentHistoryPage>): void => {
        if (!mounted.current || request !== listGeneration.current) return;
        if (result.ok) setList({ status: 'ready', page: result.data });
        else {
          setList({ status: 'error', error: result.error });
          if (
            result.error.status === 401 ||
            result.error.status === 403 ||
            ['scope_changed', 'connection_changed', 'subject_changed'].includes(
              result.error.code,
            )
          )
            initial.onScopeInvalidated();
        }
      },
    );
    return (): void => {
      mounted.current = false;
      listGeneration.current += 1;
      selectionGeneration.current += 1;
    };
  }, []);

  /** 이력 목록 기준을 바꾸면 이전 본문 선택을 숨기고 서버가 준 cursor만 사용합니다. */
  function load(nextCursors: (string | null)[]): void {
    if (locked.current) return;
    const request = ++listGeneration.current;
    selectionGeneration.current += 1;
    setList({ status: 'loading' });
    setSelected({ status: 'idle' });
    setError(null);
    setConflict(false);
    void loadDocumentVersions(input, nextCursors.at(-1) ?? null).then(
      (result: HistoryResult<DocumentHistoryPage>): void => {
        if (!mounted.current || request !== listGeneration.current) return;
        setCursors(nextCursors);
        if (result.ok) setList({ status: 'ready', page: result.data });
        else {
          setList({ status: 'error', error: result.error });
          failure(result.error);
        }
      },
    );
  }
  /** 선택 판본과 실제 현재 본문을 함께 읽고 오래된 선택 응답을 버립니다. */
  async function readSelection(historyId: string): Promise<void> {
    if (locked.current) return;
    const request = ++selectionGeneration.current;
    setSelected({ status: 'loading' });
    setError(null);
    setConflict(false);
    setRestored(null);
    const [old, current] = await Promise.all([
      loadDocumentVersion(input, historyId),
      loadCurrentDocument(input),
    ]);
    if (!mounted.current || request !== selectionGeneration.current) return;
    if (!old.ok) {
      setSelected({ status: 'error', error: old.error });
      failure(old.error);
    } else if (!current.ok) {
      setSelected({ status: 'error', error: current.error });
      failure(current.error);
    } else
      setSelected({ status: 'ready', old: old.data, current: current.data });
  }
  /** 새로고침은 읽기만 수행하고 복원을 다시 전송하지 않습니다. */
  function reload(): void {
    load([null]);
  }
  /** 서버의 다음 페이지가 있고 기준 갱신이 필요하지 않을 때만 이동합니다. */
  function next(): void {
    if (
      list.status === 'ready' &&
      list.page.next_cursor &&
      !list.page.requires_refresh
    )
      load([...cursors, list.page.next_cursor]);
  }
  /** 이미 읽은 이전 cursor로만 돌아갑니다. */
  function previous(): void {
    if (cursors.length > 1) load(cursors.slice(0, -1));
  }
  /** 판본 선택은 읽기와 비교를 수행할 뿐 현재 문서를 변경하지 않습니다. */
  function select(historyId: string): void {
    void readSelection(historyId);
  }
  /** 충돌 뒤 새 전체 본문을 재대조해야 복원 버튼을 다시 사용할 수 있습니다. */
  function compareCurrent(): void {
    if (selected.status === 'ready')
      void readSelection(selected.old.history_id);
  }
  /** 현재 비교에서 읽은 revision으로만 새 복원을 요청하고 완료/정리 경고를 구분합니다. */
  async function restore(): Promise<void> {
    if (locked.current || selected.status !== 'ready' || conflict || uncertain)
      return;
    locked.current = true;
    setBusy(true);
    setError(null);
    unconfirmedRestorations.add(key);
    const result = await restoreDocumentVersion(
      input,
      selected.old,
      selected.current,
    );
    locked.current = false;
    if (result.ok || result.error.code !== 'outcome_unknown')
      unconfirmedRestorations.delete(key);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      setRestored(result.data);
      input.onRestored(result.data);
    } else {
      setError(result.error);
      failure(result.error);
      if (result.error.code === 'outcome_unknown') setUncertain(true);
      if (result.error.status === 409 || result.error.code === 'conflict')
        setConflict(true);
    }
  }
  return {
    list,
    selected,
    pageNumber: cursors.length,
    canPrevious: cursors.length > 1,
    busy,
    conflict,
    uncertain,
    restored,
    error,
    reload,
    next,
    previous,
    select,
    compareCurrent,
    restore,
  };
}
