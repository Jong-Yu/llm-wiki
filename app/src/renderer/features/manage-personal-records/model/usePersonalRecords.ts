import { useCallback, useEffect, useRef, useState } from 'react';
import {
  confirmPersonal,
  listPersonal,
  loadPersonalSession,
  readPersonal,
  writePersonal,
} from '../api/personalRecords.api';
import { personalKind } from './personalRecords';
import type {
  PendingReceipt,
  PersonalError,
  PersonalMode,
  PersonalMutation,
  PersonalPage,
  PersonalSession,
  PersonalWriteState,
  RecordEnvelope,
} from './personalRecords';

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: PersonalError }
  | { status: 'ready'; data: T };
type PersonalModel = {
  session: LoadState<PersonalSession>;
  page: LoadState<PersonalPage>;
  selected: RecordEnvelope | null;
  inspection: RecordEnvelope | null;
  write: PersonalWriteState;
  pageIndex: number;
  blocked: boolean;
  refresh: () => void;
  next: () => void;
  previous: () => void;
  select: (id: string) => void;
  refreshSelected: () => void;
  mutate: (
    request: PersonalMutation,
    receipt: PendingReceipt,
  ) => Promise<RecordEnvelope | null>;
  confirm: () => Promise<RecordEnvelope | null>;
  inspect: () => void;
  discardAndReload: () => void;
  invalidate: (error: PersonalError) => void;
};
// 요청 ID만 메모리에 보존해 화면 이동 후에도 결과 미확인 저장을 새 POST로 반복하지 않습니다.
const unresolved = new Map<string, PendingReceipt>();
/** 개인 소유 범위를 요청 ID 확인 저장소의 키로 사용합니다. */
function scopeKey(session: PersonalSession): string {
  return JSON.stringify([
    session.connectionId,
    session.userId,
    session.tenant,
    session.profileId,
    session.policyRevision,
  ]);
}
/** 현재 연결과 개인 기록의 읽기 수명·CAS 초안·응답 유실을 관리합니다. */
export function usePersonalRecords(mode: PersonalMode): PersonalModel {
  const [session, setSession] = useState<LoadState<PersonalSession>>({
    status: 'loading',
  });
  const [page, setPage] = useState<LoadState<PersonalPage>>({
    status: 'loading',
  });
  const [selected, setSelected] = useState<RecordEnvelope | null>(null);
  const [inspection, setInspection] = useState<RecordEnvelope | null>(null);
  const [write, setWrite] = useState<PersonalWriteState>({ status: 'idle' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const lifetime = useRef(0);
  const selectionLife = useRef(0);
  const pageLife = useRef(0);
  const busy = useRef(false);
  const scope = session.status === 'ready' ? session.data : null;

  /** 권한·범위 오류는 이전 개인 본문과 폼을 즉시 숨깁니다. */
  const invalidate = useCallback((error: PersonalError): void => {
    if (
      error.status === 401 ||
      error.status === 403 ||
      ['scope_changed', 'selection_required', 'connection_required'].includes(
        error.code,
      )
    ) {
      lifetime.current += 1;
      selectionLife.current += 1;
      setSelected(null);
      setInspection(null);
      setSession({ status: 'error', error });
    }
  }, []);
  /** 페이지 이동은 선택한 편집 기준을 갱신하지 않습니다. */
  const loadPage = useCallback(
    async (current: PersonalSession, cursor: string | null): Promise<void> => {
      const stamp = lifetime.current;
      const pageStamp = ++pageLife.current;
      setPage({ status: 'loading' });
      const result = await listPersonal(mode, current, cursor);
      if (stamp !== lifetime.current || pageStamp !== pageLife.current) return;
      if (result.ok) setPage({ status: 'ready', data: result.data });
      else {
        setPage({ status: 'error', error: result.error });
        invalidate(result.error);
      }
    },
    [mode, invalidate],
  );
  useEffect((): (() => void) => {
    const stamp = ++lifetime.current;
    void loadPersonalSession().then(
      (result: Awaited<ReturnType<typeof loadPersonalSession>>): void => {
        if (stamp !== lifetime.current) return;
        if (!result.ok) {
          setSession({ status: 'error', error: result.error });
          return;
        }
        setSession({ status: 'ready', data: result.data });
        const pending = unresolved.get(scopeKey(result.data));
        if (pending)
          setWrite({
            status: 'blocked',
            receipt: pending,
            error: {
              code: 'outcome_unknown',
              message:
                '이 연결에 결과가 확인되지 않은 저장 요청이 있습니다. 동일 요청의 수신 기록을 확인해 주세요.',
            },
          });
        void loadPage(result.data, null);
      },
    );
    return (): void => {
      lifetime.current += 1;
      selectionLife.current += 1;
    };
  }, [mode, loadPage]);

  /** 선택 응답이 늦게 와도 새로 선택한 기록을 덮어쓰지 않습니다. */
  async function choose(id: string): Promise<void> {
    if (!scope || busy.current || write.status === 'blocked') return;
    const stamp = ++selectionLife.current;
    const outer = lifetime.current;
    setSelected(null);
    setInspection(null);
    setWrite({ status: 'idle' });
    const result = await readPersonal(mode, id, scope);
    if (stamp !== selectionLife.current || outer !== lifetime.current) return;
    if (result.ok) setSelected(result.data);
    else {
      setWrite({ status: 'error', error: result.error });
      invalidate(result.error);
    }
  }
  /** 저장 답변을 다시 읽되 작성 중인 폼을 제거하거나 선택 수명을 바꾸지 않습니다. */
  async function refreshSelected(): Promise<void> {
    if (!scope || !selected || busy.current || write.status === 'blocked')
      return;
    const stamp = ++selectionLife.current;
    const outer = lifetime.current;
    const result = await readPersonal(mode, selected.record.id, scope);
    if (stamp !== selectionLife.current || outer !== lifetime.current) return;
    if (result.ok) setSelected(result.data);
    else {
      setWrite({ status: 'error', error: result.error });
      invalidate(result.error);
    }
  }
  /** 쓰기는 한 번만 실행하며 409와 미확인 응답에서는 초안과 기준 판본을 고정합니다. */
  async function mutate(
    request: PersonalMutation,
    receipt: PendingReceipt,
  ): Promise<RecordEnvelope | null> {
    if (!scope || busy.current || write.status === 'blocked') return null;
    busy.current = true;
    selectionLife.current += 1;
    const stamp = lifetime.current;
    setWrite({ status: 'saving' });
    unresolved.set(scopeKey(scope), receipt);
    const result = await writePersonal(request, receipt, scope);
    busy.current = false;
    // 화면이 닫혀도 전송한 요청 식별자를 남겨 미확인 변경을 새 POST로 반복하지 않습니다.
    if (result.ok || result.error.code !== 'outcome_unknown')
      unresolved.delete(scopeKey(scope));
    if (stamp !== lifetime.current) return null;
    if (!result.ok) {
      const unknown = result.error.code === 'outcome_unknown';
      if (unknown) unresolved.set(scopeKey(scope), receipt);
      const blocked =
        unknown ||
        result.error.code === 'conflict' ||
        result.error.status === 409;
      setWrite(
        blocked
          ? {
              status: 'blocked',
              error: result.error,
              ...(unknown ? { receipt } : {}),
            }
          : { status: 'error', error: result.error },
      );
      invalidate(result.error);
      return null;
    }
    unresolved.delete(scopeKey(scope));
    setWrite({
      status: 'saved',
      message:
        result.data.replayed === true
          ? '동일 요청의 저장 기록을 확인했습니다.'
          : '개인 기록을 저장했습니다.',
    });
    if (result.data.record.kind === personalKind(mode)) {
      setSelected(result.data);
      setInspection(null);
    }
    void loadPage(scope, cursors[pageIndex] || null);
    return result.data;
  }
  /** 미확인 저장은 동일 요청의 읽기 수신 기록만 조회합니다. 404도 실패로 단정하지 않습니다. */
  async function confirm(): Promise<RecordEnvelope | null> {
    if (!scope || write.status !== 'blocked' || !write.receipt || busy.current)
      return null;
    busy.current = true;
    const receipt = write.receipt;
    const stamp = lifetime.current;
    const result = await confirmPersonal(receipt, scope);
    busy.current = false;
    if (stamp !== lifetime.current) return null;
    if (!result.ok) {
      setWrite({
        status: 'blocked',
        receipt,
        error: {
          ...result.error,
          message: `${result.error.message} 저장 여부는 아직 미확인입니다. 새 요청으로 반복하지 마세요.`,
        },
      });
      invalidate(result.error);
      return null;
    }
    unresolved.delete(scopeKey(scope));
    setWrite({
      status: 'saved',
      message: '동일 요청이 저장된 것을 수신 기록에서 확인했습니다.',
    });
    if (result.data.record.kind === personalKind(mode)) {
      setSelected(result.data);
      setInspection(null);
    }
    void loadPage(scope, cursors[pageIndex] || null);
    return result.data;
  }
  /** 충돌 후 현재 기록은 읽기 전용 대조본으로만 읽어 초안 기준을 바꾸지 않습니다. */
  async function inspect(): Promise<void> {
    if (!scope || !selected) return;
    const stamp = lifetime.current;
    const result = await readPersonal(mode, selected.record.id, scope);
    if (stamp !== lifetime.current) return;
    if (result.ok) setInspection(result.data);
    else {
      setWrite({
        status: 'blocked',
        error: result.error,
        ...(write.status === 'blocked' && write.receipt
          ? { receipt: write.receipt }
          : {}),
      });
      invalidate(result.error);
    }
  }
  /** 사용자가 초안을 닫기로 선택한 경우에만 최신 기록을 새 편집 대상으로 선택합니다. */
  function discardAndReload(): void {
    if (!scope || write.status !== 'blocked' || write.receipt) return;
    setWrite({ status: 'idle' });
    setInspection(null);
    if (inspection) setSelected(inspection);
    else {
      setSelected(null);
      void loadPage(scope, cursors[pageIndex] || null);
    }
  }
  return {
    session,
    page,
    selected,
    inspection,
    write,
    pageIndex,
    blocked: write.status === 'blocked' || write.status === 'saving',
    refresh: (): void => {
      if (scope) void loadPage(scope, cursors[pageIndex] || null);
    },
    next: (): void => {
      if (!scope || page.status !== 'ready' || !page.data.next_cursor) return;
      const cursor = page.data.next_cursor;
      setCursors((current: (string | null)[]): (string | null)[] => [
        ...current.slice(0, pageIndex + 1),
        cursor,
      ]);
      setPageIndex(pageIndex + 1);
      void loadPage(scope, cursor);
    },
    previous: (): void => {
      if (!scope || pageIndex < 1) return;
      setPageIndex(pageIndex - 1);
      void loadPage(scope, cursors[pageIndex - 1] || null);
    },
    select: (id: string): void => {
      void choose(id);
    },
    refreshSelected: (): void => {
      void refreshSelected();
    },
    mutate,
    confirm,
    inspect: (): void => {
      void inspect();
    },
    discardAndReload,
    invalidate,
  };
}
export type { PersonalModel };
