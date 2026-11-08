import { z } from 'zod';
import type { EditableMetadata } from './documentMetadata';
import type { DocumentContent } from '@contracts/documents.contract';

export const documentDraftSchema = z.object({
  content: z
    .string()
    .refine(
      (value: string): boolean =>
        new TextEncoder().encode(value).byteLength <= 1024 * 1024,
      '본문은 UTF-8 1 MiB 이내여야 합니다. 내용을 임의로 자르지 않습니다.',
    ),
});
export type DocumentDraft = {
  base: DocumentContent;
  content: string;
  metadata?: EditableMetadata;
  mergedMetadata?: EditableMetadata;
  phase: 'edit' | 'compare' | 'conflict' | 'unknown';
  latest: DocumentContent | null;
  merged: string;
  preserved: {
    revision: string;
    content: string;
    metadata?: EditableMetadata;
  }[];
};
const drafts = new Map<string, DocumentDraft>();

/** 연결·주체·공간·관점·정책을 모두 키로 사용해 다른 범위에 초안을 노출하지 않습니다. */
export function contentDraftKey(current: DocumentContent): string {
  return JSON.stringify([
    current.connectionId,
    current.access.userId,
    current.access.tenant,
    current.access.profileId,
    current.access.accessRevision ?? current.access.policyRevision,
    current.document,
  ]);
}
/** 같은 앱 세션에서 복원할 때도 원래 CAS 기준은 교체하지 않습니다. */
export function restoreContentDraft(current: DocumentContent): DocumentDraft {
  const cached = drafts.get(contentDraftKey(current));
  if (!cached)
    return {
      base: current,
      content: current.content,
      phase: 'edit',
      latest: null,
      merged: '',
      preserved: [],
    };
  if (cached.base.revision !== current.revision)
    return {
      ...cached,
      phase: cached.phase === 'unknown' ? 'unknown' : 'conflict',
      latest: current,
      merged:
        cached.latest?.revision === current.revision
          ? cached.merged
          : current.content,
      mergedMetadata:
        cached.latest?.revision === current.revision
          ? cached.mergedMetadata
          : undefined,
      preserved:
        cached.latest &&
        cached.latest.revision !== current.revision &&
        (cached.merged !== cached.latest.content ||
          cached.mergedMetadata !== undefined)
          ? [
              ...cached.preserved,
              {
                revision: cached.latest.revision,
                content: cached.merged,
                metadata: cached.mergedMetadata,
              },
            ]
          : cached.preserved,
    };
  return cached;
}
/** 탭·경로 이동과 실패에서도 기준 본문과 편집안을 함께 보존합니다. */
export function rememberContentDraft(draft: DocumentDraft): void {
  drafts.set(contentDraftKey(draft.base), draft);
}
/** 서버 저장 영수증을 받은 초안만 현재 세션 캐시에서 해제합니다. */
export function settleContentDraft(
  pending: DocumentDraft,
  next: DocumentDraft | null,
): void {
  const key = contentDraftKey(pending.base);
  // 이전 화면의 지연 응답이 재진입 후 작성한 초안을 지우거나 덮어쓰지 않습니다.
  if (drafts.get(key) !== pending) return;
  if (next) drafts.set(key, next);
  else drafts.delete(key);
}
/** 최신 전체 본문에서 직접 재작성한 결과를 새 비교 초안으로 만들며 원래 초안도 남깁니다. */
export function reconcileContentDraft(
  draft: DocumentDraft,
): DocumentDraft | null {
  if (
    !draft.latest ||
    !documentDraftSchema.safeParse({ content: draft.merged }).success
  )
    return null;
  return {
    base: draft.latest,
    content: draft.merged,
    phase: 'compare',
    metadata: draft.mergedMetadata,
    mergedMetadata: undefined,
    latest: null,
    merged: '',
    preserved: [
      ...draft.preserved,
      {
        revision: draft.base.revision,
        content: draft.content,
        metadata: draft.metadata,
      },
    ],
  };
}
