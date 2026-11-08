import {
  editableMetadataSchema,
  draftParts,
  draftMetadataFields,
  replaceMetadata,
} from './documentMetadata';
import type { EditableMetadata } from './documentMetadata';
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { DocumentContent } from '@contracts/documents.contract';
import type { QueryCacheNotifyEvent } from '@tanstack/react-query';
import { useReadQueries } from '@renderer/shared/lib/readQueries';
import { queryCurrentContent } from '../api/documentContent.queries';
import {
  restoreDocumentVersion,
  saveDocumentContent,
} from '../api/documentContent.api';
import type {
  ContentFailure,
  ContentSession,
  HistoricalContent,
  SaveReceipt,
} from '../api/documentContent.api';
import {
  documentDraftSchema,
  contentDraftKey,
  restoreContentDraft,
  rememberContentDraft,
  settleContentDraft,
  reconcileContentDraft,
} from './documentDraft';
import type { DocumentDraft } from './documentDraft';
import {
  readDocumentRestoration,
  settleDocumentRestoration,
  subscribeDocumentRestoration,
} from './documentRestoration';
import type { DocumentRestoration } from './documentRestoration';

type DocumentEditingInput = {
  current: DocumentContent;
  onInvalidated: () => void;
};
type RestorationState = DocumentRestoration['phase'] | null;
export type DocumentEditingModel = {
  current: DocumentContent;
  draft: DocumentDraft;
  busy: boolean;
  error: ContentFailure | null;
  receipt: SaveReceipt | null;
  restoration: RestorationState;
  restore: (historical: HistoricalContent) => Promise<void>;
  checkRestoration: () => Promise<void>;
  change: (content: string) => void;
  changeMetadata: (fields: EditableMetadata, merged?: boolean) => void;
  compare: () => void;
  edit: () => void;
  save: () => Promise<void>;
  loadLatest: () => Promise<void>;
  refreshPristine: () => Promise<void>;
  changeMerge: (content: string) => void;
  reconcile: () => void;
};

/** 사용자가 보존해야 할 입력·비교·미확인 결과가 없는 경우만 새 본문을 채택합니다. */
function isPristine(draft: DocumentDraft): boolean {
  return (
    draft.phase === 'edit' &&
    draft.content === draft.base.content &&
    draft.metadata === undefined &&
    draft.mergedMetadata === undefined &&
    draft.latest === null &&
    draft.preserved.length === 0
  );
}

/** 저장 성패와 편집안을 분리하며 충돌·응답 유실에서 오래된 본문을 재전송하지 않습니다. */
export function useDocumentEditing({
  current: initial,
  onInvalidated,
}: DocumentEditingInput): DocumentEditingModel {
  const { cache } = useReadQueries();
  /** 명시 최신 확인은 캐시 유효 시간과 무관하게 기존 현재 본문 계약을 사용합니다. */
  const readDocumentContent = (
    path: string,
    expected?: DocumentContent,
  ): ReturnType<typeof queryCurrentContent> =>
    queryCurrentContent(cache, path, expected);
  const [current, setCurrent] = useState(initial);
  const [draft, setDraft] = useState<DocumentDraft>((): DocumentDraft =>
    restoreContentDraft(initial),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ContentFailure | null>(null);
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  const restorationRecord = useSyncExternalStore(
    subscribeDocumentRestoration,
    (): DocumentRestoration | null => readDocumentRestoration(initial),
  );
  const restoration = restorationRecord?.phase ?? null;
  const pending = useRef(false);
  const alive = useRef(false);
  const latestDraft = useRef(draft);
  const observeCurrent = useEffectEvent((value: DocumentContent): void => {
    adoptPristineContent(value);
  });
  useEffect((): (() => void) => {
    alive.current = true;
    /** 앱 종료 후 복구 계약이 없으므로 저장하지 않은 종료를 브라우저에 경고합니다. */
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      const value = latestDraft.current;
      if (
        pending.current ||
        readDocumentRestoration(initial) !== null ||
        value.content !== value.base.content ||
        value.metadata !== undefined ||
        value.mergedMetadata !== undefined ||
        value.phase === 'unknown' ||
        value.preserved.length > 0 ||
        (value.latest !== null && value.merged !== value.latest.content)
      )
        event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return (): void => {
      alive.current = false;
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [initial]);
  useEffect((): (() => void) => {
    const key = cache.key('document-content', initial.document);
    const observe = (): void => {
      const session = cache.client.getQueryData<ContentSession>(key);
      if (session) observeCurrent(session.current);
    };
    const unsubscribe = cache.client
      .getQueryCache()
      .subscribe((event: QueryCacheNotifyEvent): void => {
        if (
          event.type === 'updated' &&
          event.action.type === 'success' &&
          JSON.stringify(event.query.queryKey) === JSON.stringify(key)
        )
          observe();
      });
    observe();
    return unsubscribe;
  }, [cache, initial.document]);
  /** 캐시와 화면 상태를 같은 순간에 바꾸어 경로 이동 직전 입력을 보존합니다. */
  function update(value: DocumentDraft): void {
    latestDraft.current = value;
    rememberContentDraft(value);
    setDraft(value);
  }
  /** 복원 후 서버에서 읽은 실제 전체 파일만 편집 기준으로 채택합니다. */
  function adoptRestoredContent(value: DocumentContent): void {
    settleContentDraft(latestDraft.current, null);
    const next: DocumentDraft = {
      base: value,
      content: value.content,
      phase: 'edit',
      latest: null,
      merged: '',
      preserved: [],
    };
    latestDraft.current = next;
    setDraft(next);
    setCurrent(value);
  }
  /** 배경 읽기도 검증된 같은 범위의 본문만 복사하며 미저장 CAS 기준은 유지합니다. */
  function adoptPristineContent(value: DocumentContent): void {
    const baseline = latestDraft.current;
    if (
      !alive.current ||
      pending.current ||
      readDocumentRestoration(initial) !== null ||
      !isPristine(baseline) ||
      contentDraftKey(value) !== contentDraftKey(baseline.base) ||
      value.revision === baseline.base.revision
    )
      return;
    const received = structuredClone(value);
    const refreshed: DocumentDraft = {
      base: received,
      content: received.content,
      phase: 'edit',
      latest: null,
      merged: '',
      preserved: [],
    };
    settleContentDraft(baseline, null);
    latestDraft.current = refreshed;
    setDraft(refreshed);
    setCurrent(received);
    setReceipt(null);
    setError(null);
  }
  /** 접근 거부는 일반 재시도와 구별하여 이전 범위를 숨깁니다. */
  function fail(failure: ContentFailure): void {
    setError(failure);
    if (
      failure.status === 401 ||
      failure.status === 403 ||
      ['scope_changed', 'connection_changed', 'subject_changed'].includes(
        failure.code,
      )
    )
      onInvalidated();
  }
  /** 읽기로 돌아온 문서만 갱신하며 미저장·비교·재반영·미확인 초안은 그대로 둡니다. */
  async function refreshPristine(): Promise<void> {
    const baseline = latestDraft.current;
    if (
      pending.current ||
      readDocumentRestoration(initial) !== null ||
      !isPristine(baseline)
    )
      return;
    pending.current = true;
    setBusy(true);
    const result = await readDocumentContent(
      baseline.base.document,
      baseline.base,
    );
    pending.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (latestDraft.current !== baseline) return;
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setError(null);
    adoptPristineContent(result.data.current);
  }
  /** 원래 기준을 유지하며 편집 내용만 바꿉니다. */
  function change(content: string): void {
    if (
      !pending.current &&
      readDocumentRestoration(initial) === null &&
      draft.phase === 'edit'
    ) {
      update({ ...draft, content });
      setReceipt(null);
    }
  }
  /** 유효하지 않은 설명 입력도 초안에 보존하고 유효할 때만 전체 파일에 반영합니다. */
  function changeMetadata(
    fields: EditableMetadata,
    merged: boolean = false,
  ): void {
    if (pending.current || readDocumentRestoration(initial) !== null) return;
    const parsed = editableMetadataSchema.safeParse(fields);
    if (merged && draft.latest)
      update({
        ...draft,
        mergedMetadata: fields,
        merged: parsed.success
          ? replaceMetadata(draft.latest, draft.merged, parsed.data)
          : draft.merged,
      });
    else if (draft.phase === 'edit')
      update({
        ...draft,
        metadata: fields,
        content: parsed.success
          ? replaceMetadata(draft.base, draft.content, parsed.data)
          : draft.content,
      });
    setReceipt(null);
  }
  /** 비교 진입 전에 원시 폼 값까지 검증하며 입력을 버리지 않습니다. */
  function validMetadata(fields: EditableMetadata | undefined): boolean {
    if (!fields) return true;
    const parsed = editableMetadataSchema.safeParse(fields);
    if (parsed.success) return true;
    setError({
      code: 'invalid_metadata',
      message: parsed.error.issues[0]?.message ?? '문서 설명을 확인해 주세요.',
    });
    return false;
  }
  /** 빈 본문을 포함한 전체 UTF-8 크기를 확인하고 저장 전 비교로 전환합니다. */
  function compare(): void {
    if (
      pending.current ||
      readDocumentRestoration(initial) !== null ||
      draft.phase !== 'edit' ||
      !validMetadata(draft.metadata)
    )
      return;
    const parsed = documentDraftSchema.safeParse({ content: draft.content });
    if (!parsed.success) {
      setError({
        code: 'document_too_large',
        message:
          parsed.error.issues[0]?.message ?? '본문 크기를 확인해 주세요.',
      });
      return;
    }
    setError(null);
    update({ ...draft, phase: 'compare' });
  }
  /** 비교에서 돌아가도 본문과 CAS 기준은 유지합니다. */
  function edit(): void {
    if (
      !pending.current &&
      readDocumentRestoration(initial) === null &&
      draft.phase === 'compare'
    )
      update({ ...draft, phase: 'edit' });
  }
  /** 편집 중에도 바로 저장할 수 있으며, 한 번의 명시 저장만 수행하고 storage_busy는 충돌로 바꾸지 않습니다. */
  async function save(): Promise<void> {
    if (
      pending.current ||
      readDocumentRestoration(initial) !== null ||
      (draft.phase !== 'compare' && draft.phase !== 'edit') ||
      (draft.phase === 'edit' && !validMetadata(draft.metadata)) ||
      !documentDraftSchema.safeParse({ content: draft.content }).success
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const sent = draft;
    const pendingDraft: DocumentDraft = { ...sent, phase: 'unknown' };
    rememberContentDraft(pendingDraft);
    const result = await saveDocumentContent(sent.base, sent.content);
    pending.current = false;
    const next: DocumentDraft = result.ok
      ? {
          ...sent,
          base: {
            ...sent.base,
            content: sent.content,
            revision: result.data.revision,
            body: draftParts(sent.base, sent.content).body,
            metadata: sent.base.documentId
              ? {
                  ...sent.base.metadata,
                  title: draftMetadataFields(sent.base, sent.content).title,
                  tags: draftMetadataFields(sent.base, sent.content)
                    .tags.split(',')
                    .map((tag: string): string => tag.trim())
                    .filter(Boolean),
                  description: draftMetadataFields(sent.base, sent.content)
                    .description,
                }
              : sent.base.metadata,
          },
          phase: 'edit',
          metadata: undefined,
          mergedMetadata: undefined,
          latest: null,
          merged: '',
          preserved: [],
        }
      : {
          ...sent,
          phase:
            result.error.code === 'outcome_unknown'
              ? 'unknown'
              : result.error.code === 'conflict'
                ? 'conflict'
                : 'compare',
        };
    settleContentDraft(pendingDraft, result.ok ? null : next);
    if (!alive.current) return;
    setBusy(false);
    latestDraft.current = next;
    setDraft(next);
    if (result.ok) {
      setCurrent(next.base);
      setReceipt(result.data);
    } else fail(result.error);
  }
  /** 비교한 판본만 한 번 복원하며 편집 중인 초안을 덮어쓰지 않습니다. */
  async function restore(historical: HistoricalContent): Promise<void> {
    const baseline = latestDraft.current;
    if (
      pending.current ||
      readDocumentRestoration(initial) !== null ||
      baseline.phase !== 'edit' ||
      baseline.content !== baseline.base.content ||
      baseline.metadata !== undefined ||
      baseline.mergedMetadata !== undefined ||
      baseline.latest !== null ||
      baseline.preserved.length > 0
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setReceipt(null);
    const sent: DocumentRestoration = {
      phase: 'pending',
      receipt: null,
      error: null,
    };
    settleDocumentRestoration(baseline.base, null, sent);
    const result = await restoreDocumentVersion(baseline.base, historical);
    if (!result.ok) {
      pending.current = false;
      const phase =
        result.error.code === 'outcome_unknown'
          ? 'unknown'
          : result.error.code === 'conflict'
            ? 'conflict'
            : null;
      settleDocumentRestoration(
        baseline.base,
        sent,
        phase ? { phase, receipt: null, error: result.error } : null,
      );
      if (!alive.current) return;
      setBusy(false);
      fail(result.error);
      return;
    }
    // 언마운트 뒤에도 성공 영수증을 보존하고 재진입 화면은 명시적으로 다시 읽습니다.
    const saved: DocumentRestoration = {
      phase: 'saved',
      receipt: result.data,
      error: null,
    };
    settleDocumentRestoration(baseline.base, sent, saved);
    if (!alive.current) return;
    setReceipt(result.data);
    const refreshed = await readDocumentContent(
      baseline.base.document,
      baseline.base,
    );
    pending.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (refreshed.ok) {
      if (settleDocumentRestoration(baseline.base, saved, null))
        adoptRestoredContent(refreshed.data.current);
    } else {
      const failure = {
        ...refreshed.error,
        message: `버전 복원은 완료했지만 현재 본문을 다시 읽지 못했습니다. ${refreshed.error.message}`,
      };
      settleDocumentRestoration(baseline.base, saved, {
        ...saved,
        error: failure,
      });
      fail(failure);
    }
  }
  /** 충돌·미확인 복원은 최신 본문을 새로 비교할 수 있게 읽으며 쓰기를 반복하지 않습니다. */
  async function checkRestoration(): Promise<void> {
    const previous = readDocumentRestoration(initial);
    if (pending.current || previous === null || previous.phase === 'pending')
      return;
    pending.current = true;
    setBusy(true);
    const result = await readDocumentContent(current.document, current);
    pending.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (!result.ok) {
      settleDocumentRestoration(initial, previous, {
        ...previous,
        error: result.error,
      });
      fail(result.error);
      return;
    }
    if (!settleDocumentRestoration(initial, previous, null)) return;
    setReceipt(previous.receipt);
    adoptRestoredContent(result.data.current);
    setError(
      previous.phase === 'unknown'
        ? {
            code: 'restore_unconfirmed',
            message:
              '현재 본문을 다시 읽었습니다. 이전 복원 요청의 성공 여부는 확정하지 않았습니다. 이력과 본문을 비교한 뒤 필요한 작업을 선택해 주세요.',
          }
        : null,
    );
  }
  /** 최신 본문은 비교 자료로만 저장하고 기존 초안의 revision을 교체하지 않습니다. */
  async function loadLatest(): Promise<void> {
    if (pending.current || readDocumentRestoration(initial) !== null) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const result = await readDocumentContent(draft.base.document, draft.base);
    pending.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.ok)
      update({
        ...draft,
        latest: result.data.current,
        merged: result.data.current.content,
      });
    else fail(result.error);
  }
  /** 충돌 비교 입력은 최신 본문에서 시작하며 원래 초안을 별도로 보존합니다. */
  function changeMerge(content: string): void {
    if (
      !pending.current &&
      readDocumentRestoration(initial) === null &&
      draft.latest
    )
      update({ ...draft, merged: content });
  }
  /** 사용자가 대조 후 선택한 본문만 새로운 비교 단계로 넘깁니다. */
  function reconcile(): void {
    if (
      pending.current ||
      readDocumentRestoration(initial) !== null ||
      !validMetadata(draft.mergedMetadata)
    )
      return;
    const next = reconcileContentDraft(draft);
    if (!next) {
      setError({
        code: 'document_too_large',
        message: '재반영할 본문은 UTF-8 1 MiB 이내여야 합니다.',
      });
      return;
    }
    setError(null);
    setCurrent(next.base);
    update(next);
  }
  return {
    current,
    draft,
    busy: busy || restoration === 'pending',
    error: restorationRecord?.error ?? error,
    receipt: restorationRecord?.receipt ?? receipt,
    restoration,
    restore,
    checkRestoration,
    change,
    changeMetadata,
    compare,
    edit,
    save,
    loadLatest,
    refreshPristine,
    changeMerge,
    reconcile,
  };
}
