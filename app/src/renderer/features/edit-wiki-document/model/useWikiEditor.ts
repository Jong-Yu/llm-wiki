import { useEffect, useRef, useState } from 'react';
import type { DocumentContent } from '@contracts/documents.contract';
import { readCurrentWiki, saveWikiDocument } from '../api/wikiEditor.api';
import type { DocumentSaveOutcome, EditorFailure } from '../api/wikiEditor.api';

type Phase = 'edit' | 'compare' | 'conflict' | 'unknown' | 'saved';
type Draft = {
  base: DocumentContent;
  content: string;
  phase: Phase;
  latest: DocumentContent | null;
};
type Input = {
  current: DocumentContent;
  onSaved: (outcome: DocumentSaveOutcome) => void;
  onScopeInvalidated: () => void;
};
export type WikiEditorModel = {
  draft: Draft;
  busy: boolean;
  error: EditorFailure | null;
  saved: DocumentSaveOutcome | null;
  change: (content: string) => void;
  compare: (content: string) => void;
  edit: () => void;
  save: () => Promise<void>;
  readLatest: () => Promise<void>;
  adoptLatest: () => void;
};
const drafts = new Map<string, Draft>();

/** 초안은 같은 연결·주체·관점·문서에서만 복원하고 토큰/파일에는 보관하지 않습니다. */
function draftKey(current: DocumentContent): string {
  return JSON.stringify([
    current.connectionId,
    current.access.userId,
    current.access.tenant,
    current.access.profileId,
    current.access.policyRevision,
    current.document,
  ]);
}

/** 재열람 시 기존 초안의 기준 판본을 바꾸지 않고 현재 본문과의 차이를 알립니다. */
function initialDraft(current: DocumentContent): Draft {
  const draft = drafts.get(draftKey(current));
  if (!draft)
    return {
      base: current,
      content: current.content,
      phase: 'edit',
      latest: null,
    };
  if (draft.base.revision !== current.revision && draft.phase !== 'unknown')
    return { ...draft, phase: 'conflict', latest: current };
  return draft;
}

/** 수정안·기준 본문·미확정 상태를 보존하고 읽기와 명시 저장을 구분합니다. */
export function useWikiEditor({
  current,
  onSaved,
  onScopeInvalidated,
}: Input): WikiEditorModel {
  const [draft, setDraft] = useState<Draft>((): Draft => initialDraft(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EditorFailure | null>(null);
  const [saved, setSaved] = useState<DocumentSaveOutcome | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const key = draftKey(current);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  /** 입력과 명시 단계 변경을 같은 초안 캐시에 보존합니다. */
  function update(next: Draft): void {
    drafts.set(key, next);
    setDraft(next);
  }
  /** 범위 변경은 부모가 이전 문서 화면을 숨기도록 전달합니다. */
  function applyError(failure: EditorFailure): void {
    setError(failure);
    if (
      failure.status === 401 ||
      failure.status === 403 ||
      ['scope_changed', 'connection_changed', 'subject_changed'].includes(
        failure.code,
      )
    )
      onScopeInvalidated();
  }
  /** 편집 중인 본문만 갱신하고 기준 판본은 유지합니다. */
  function change(content: string): void {
    if (!pending.current && draft.phase === 'edit')
      update({ ...draft, content });
  }
  /** 입력 검증을 통과한 수정안을 전체 본문 비교 단계로 옮깁니다. */
  function compare(content: string): void {
    if (!pending.current && draft.phase === 'edit') {
      setError(null);
      update({ ...draft, content, phase: 'compare' });
    }
  }
  /** 비교에서 돌아가도 수정안과 원래 기준 판본을 유지합니다. */
  function edit(): void {
    if (!pending.current && draft.phase === 'compare')
      update({ ...draft, phase: 'edit' });
  }
  /** 현재 비교에 사용한 기준에서 한 번만 저장하며 충돌/유실은 수정안을 보존합니다. */
  async function save(): Promise<void> {
    if (pending.current || draft.phase !== 'compare') return;
    pending.current = true;
    setBusy(true);
    setError(null);
    // 전송 중 화면이 사라져도 미확정 요청을 새 저장으로 오해하지 않습니다.
    drafts.set(key, { ...draft, phase: 'unknown' });
    const result = await saveWikiDocument(draft.base, draft.content);
    pending.current = false;
    if (result.ok) drafts.delete(key);
    else
      drafts.set(key, {
        ...draft,
        phase:
          result.error.code === 'outcome_unknown'
            ? 'unknown'
            : result.error.code === 'conflict' || result.error.status === 409
              ? 'conflict'
              : 'compare',
      });
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      drafts.delete(key);
      setSaved(result.outcome);
      setDraft({ ...draft, phase: 'saved' });
      onSaved(result.outcome);
    } else {
      applyError(result.error);
      if (result.error.code === 'outcome_unknown')
        update({ ...draft, phase: 'unknown' });
      else if (result.error.code === 'conflict' || result.error.status === 409)
        update({ ...draft, phase: 'conflict' });
    }
  }
  /** 最新 본문 조회는 충돌을 덮어쓰지 않고 사용자가 비교할 자료만 갱신합니다. */
  async function readLatest(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const result = await readCurrentWiki(draft.base);
    pending.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) update({ ...draft, latest: result.current });
    else applyError(result.error);
  }
  /** 전체 본문 대조 뒤 사용자가 새 편집 기준을 채택할 때만 기준을 바꿉니다. */
  function adoptLatest(): void {
    if (pending.current || draft.phase !== 'conflict' || !draft.latest) return;
    setError(null);
    update({ ...draft, base: draft.latest, latest: null, phase: 'edit' });
  }
  return {
    draft,
    busy,
    error,
    saved,
    change,
    compare,
    edit,
    save,
    readLatest,
    adoptLatest,
  };
}
