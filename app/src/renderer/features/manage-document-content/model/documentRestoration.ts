import type { DocumentContent } from '@contracts/documents.contract';
import type { ContentFailure, SaveReceipt } from '../api/documentContent.api';
import { contentDraftKey } from './documentDraft';

export type DocumentRestoration = {
  phase: 'pending' | 'conflict' | 'unknown' | 'saved';
  receipt: SaveReceipt | null;
  error: ContentFailure | null;
};
const restorations = new Map<string, DocumentRestoration>();
const listeners = new Set<() => void>();

/** 원래 인증 범위의 복원 상태만 같은 앱 세션에서 다시 읽습니다. */
export function readDocumentRestoration(
  current: DocumentContent,
): DocumentRestoration | null {
  return restorations.get(contentDraftKey(current)) ?? null;
}
/** 화면 재진입 후에도 이전 화면에서 시작한 요청의 결과를 전달합니다. */
export function subscribeDocumentRestoration(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
/** 전송 전 기록하고 요청별 객체를 대조해 지연 응답이 다음 작업을 해제하지 않게 합니다. */
export function settleDocumentRestoration(
  current: DocumentContent,
  expected: DocumentRestoration | null,
  next: DocumentRestoration | null,
): boolean {
  if (readDocumentRestoration(current) !== expected) return false;
  const key = contentDraftKey(current);
  if (next) restorations.set(key, next);
  else restorations.delete(key);
  for (const listener of listeners) listener();
  return true;
}
