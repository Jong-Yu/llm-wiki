import { useEffect, useRef, useState } from 'react';
import {
  findCorrespondences,
  loadScope,
  prepareCorrespondence,
  readCorrespondence,
  saveCorrespondence,
} from '../api/correspondences.api';
import type {
  Detail,
  Failure,
  Found,
  Intent,
  Prepared,
  Scope,
  SearchValues,
  QueryContext,
} from './correspondence.schema';
import {
  confirmedEvent,
  documentPaths,
  queryContext,
} from './correspondence.schema';

type WriteState =
  | { status: 'idle' | 'preparing' | 'saving' }
  | { status: 'prepared'; value: Prepared }
  | { status: 'error' | 'blocked'; error: Failure; pending?: Prepared }
  | { status: 'saved'; message: string };
// 화면을 다시 열어도 응답이 유실된 변경을 새 요청으로 중복 전송하지 않습니다.
const unresolved = new Map<string, Prepared>();
/** 인증 범위를 포함해 미확인 변경의 소유권을 분리합니다. */
function scopeKey(scope: Scope): string {
  return JSON.stringify([
    scope.connectionId,
    scope.userId,
    scope.tenant,
    scope.profileId,
  ]);
}
/** 조회와 변경은 별도 수명을 가지며 늦은 응답을 이전 선택에만 귀속합니다. */
export function useCorrespondences(): {
  scope: Scope | null;
  error: Failure | null;
  busy: boolean;
  found: Found | null;
  detail: Detail | null;
  inspection: Detail | null;
  write: WriteState;
  editorVersion: number;
  search: (values: SearchValues) => Promise<void>;
  select: (id: string) => Promise<void>;
  prepare: (intent: Intent) => Promise<void>;
  save: () => Promise<void>;
  inspect: () => Promise<void>;
  reset: () => void;
  clearPrepared: () => void;
  invalidate: (error: Failure) => void;
} {
  const [scope, setScope] = useState<Scope | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [inspection, setInspection] = useState<Detail | null>(null);
  const [write, setWrite] = useState<WriteState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const lifetime = useRef(0);
  const reading = useRef(0);
  const writing = useRef(false);
  const currentScope = useRef<Scope | null>(null);
  const context = useRef<QueryContext>({
    application_context: {},
    as_of: null,
  });
  useEffect((): (() => void) => {
    let active = true;
    /** 창으로 돌아올 때 현재 정책도 확인해 이전 원문을 숨깁니다. */
    async function connect(): Promise<void> {
      const result = await loadScope();
      if (!active) return;
      if (!result.ok) {
        lifetime.current += 1;
        currentScope.current = null;
        setScope(null);
        setDetail(null);
        setFound(null);
        setInspection(null);
        setError(result.error);
        return;
      }
      const previous = currentScope.current;
      const changed = JSON.stringify(previous) !== JSON.stringify(result.data);
      if (changed) {
        lifetime.current += 1;
        setDetail(null);
        setFound(null);
        setInspection(null);
        setWrite({ status: 'idle' });
        setEditorVersion((value: number): number => value + 1);
        currentScope.current = result.data;
        setScope(result.data);
      }
      const pending = unresolved.get(scopeKey(result.data));
      if (pending)
        setWrite({
          status: 'blocked',
          pending,
          error: {
            code: 'outcome_unknown',
            message:
              '이전 저장 결과가 미확인입니다. 저장 당시 대상의 이력을 대조해 주세요.',
          },
        });
      setError(null);
    }
    void connect();
    window.addEventListener('focus', connect);
    return (): void => {
      active = false;
      lifetime.current += 1;
      currentScope.current = null;
      window.removeEventListener('focus', connect);
    };
  }, []);
  /** 권한/정책 오류 뒤에는 같은 데이터를 다른 선택으로 공개하지 않습니다. */
  function invalidate(failure: Failure): void {
    if (
      failure.status === 401 ||
      failure.status === 403 ||
      ['scope_changed', 'forbidden', 'connection_required'].includes(
        failure.code,
      )
    ) {
      lifetime.current += 1;
      setScope(null);
      setFound(null);
      setDetail(null);
      setInspection(null);
      setError(failure);
    }
  }
  /** 검색은 목록만 갱신하며 준비 중인 변경을 재전송하지 않습니다. */
  async function search(values: SearchValues): Promise<void> {
    if (!scope || writing.current) return;
    const stamp = lifetime.current;
    const sequence = ++reading.current;
    setBusy(true);
    setError(null);
    const result = await findCorrespondences(
      scope,
      documentPaths(values.documents),
      values.text,
      queryContext(values),
    );
    if (stamp !== lifetime.current || sequence !== reading.current) return;
    setBusy(false);
    if (result.ok) {
      setFound(result.data);
      context.current = queryContext(values);
    } else {
      setError(result.error);
      invalidate(result.error);
    }
  }
  /** 상세를 열어도 쓰기나 준비를 시작하지 않습니다. */
  async function select(id: string): Promise<void> {
    if (!scope || writing.current || write.status === 'blocked') return;
    const stamp = lifetime.current;
    const sequence = ++reading.current;
    setBusy(true);
    setDetail(null);
    setError(null);
    const result = await readCorrespondence(scope, id, context.current);
    if (stamp !== lifetime.current || sequence !== reading.current) return;
    setBusy(false);
    if (result.ok) {
      setDetail(result.data);
      setInspection(null);
      setWrite({ status: 'idle' });
    } else {
      setError(result.error);
      invalidate(result.error);
    }
  }
  /** 최신 기준이 준비 전 상세와 다르면 준비 토큰만 갈아 끼우지 않습니다. */
  async function prepare(intent: Intent): Promise<void> {
    if (
      !scope ||
      writing.current ||
      write.status === 'blocked' ||
      unresolved.has(scopeKey(scope))
    )
      return;
    writing.current = true;
    const stamp = lifetime.current;
    setWrite({ status: 'preparing' });
    const result = await prepareCorrespondence(scope, intent);
    writing.current = false;
    if (stamp !== lifetime.current) return;
    if (result.ok) setWrite({ status: 'prepared', value: result.data });
    else {
      setWrite({
        status:
          result.error.code === 'conflict' || result.error.status === 409
            ? 'blocked'
            : 'error',
        error: result.error,
      });
      invalidate(result.error);
    }
  }
  /** 저장 성공과 후속 상세 조회 실패를 구분하며 미확인 상태는 읽기로만 대조합니다. */
  async function save(): Promise<void> {
    const retry =
      write.status === 'error' && write.error.code === 'storage_busy'
        ? write.pending
        : undefined;
    if (!scope || writing.current || (write.status !== 'prepared' && !retry))
      return;
    writing.current = true;
    const stamp = lifetime.current;
    const pending = write.status === 'prepared' ? write.value : retry;
    if (!pending) {
      writing.current = false;
      return;
    }
    unresolved.set(scopeKey(scope), pending);
    setWrite({ status: 'saving' });
    const result = await saveCorrespondence(scope, pending);
    writing.current = false;
    if (!result.ok) {
      const uncertain = ['outcome_unknown', 'scope_changed'].includes(
        result.error.code,
      );
      if (!uncertain) unresolved.delete(scopeKey(scope));
      if (stamp !== lifetime.current) return;
      setWrite({
        status:
          uncertain ||
          result.error.code === 'conflict' ||
          result.error.status === 409
            ? 'blocked'
            : 'error',
        error: result.error,
        ...(uncertain || result.error.code === 'storage_busy'
          ? { pending }
          : {}),
      });
      invalidate(result.error);
      return;
    }
    unresolved.delete(scopeKey(scope));
    if (stamp !== lifetime.current) return;
    setWrite({
      status: 'saved',
      message: `저장 완료 · 이벤트 ${result.data.eventId}${result.data.warnings ? ` · 임시 파일 정리 경고 ${result.data.warnings}건` : ''}`,
    });
    setEditorVersion((value: number): number => value + 1);
    const updated = await readCorrespondence(
      scope,
      result.data.id,
      context.current,
    );
    if (stamp !== lifetime.current) return;
    if (updated.ok) setDetail(updated.data);
    else {
      setError({
        ...updated.error,
        message: `저장은 완료됐지만 최신 이력을 읽지 못했습니다. ${updated.error.message}`,
      });
      invalidate(updated.error);
    }
  }
  /** 충돌/미확인 뒤 조회는 원래 초안 기준을 바꾸지 않는 별도 대조본입니다. */
  async function inspect(): Promise<void> {
    if (!scope || writing.current) return;
    const pending = write.status === 'blocked' ? write.pending : undefined;
    const id = pending?.response.correspondence_id || detail?.correspondence_id;
    if (!id) return;
    const stamp = lifetime.current;
    setBusy(true);
    const result = await readCorrespondence(scope, id, context.current);
    if (stamp !== lifetime.current) return;
    setBusy(false);
    if (result.ok) {
      setInspection(result.data);
      const eventId = pending
        ? confirmedEvent(result.data, pending, scope.userId)
        : null;
      if (eventId) {
        unresolved.delete(scopeKey(scope));
        setWrite({
          status: 'saved',
          message: `저장 완료를 이력에서 확인했습니다 · 이벤트 ${eventId}`,
        });
        setDetail(result.data);
        setEditorVersion((value: number): number => value + 1);
      }
    } else {
      setError(result.error);
      invalidate(result.error);
    }
  }
  /** 명시적으로 초안을 버릴 때만 충돌 대조본을 새 편집 기준으로 사용합니다. */
  function reset(): void {
    if (writing.current || (write.status === 'blocked' && write.pending))
      return;
    setWrite({ status: 'idle' });
    if (inspection) setDetail(inspection);
    setInspection(null);
    setEditorVersion((value: number): number => value + 1);
  }
  /** 작성자가 내용을 바꾸면 이전 준비를 폐기하고 다시 대조하게 합니다. */
  function clearPrepared(): void {
    if (write.status === 'prepared' || write.status === 'error')
      setWrite({ status: 'idle' });
  }
  return {
    scope,
    error,
    busy,
    found,
    detail,
    inspection,
    write,
    editorVersion,
    search,
    select,
    prepare,
    save,
    inspect,
    reset,
    clearPrepared,
    invalidate,
  };
}
