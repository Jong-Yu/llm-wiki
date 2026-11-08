import { ReviewQueueError } from '../api/reviewQueue.api';
import type { ReviewQueueItem, ReviewQueuePage } from './reviewQueue.types';

/** 같은 접근 범위와 자료 판본의 다음 페이지만 합치고 실제 누락을 보존합니다. */
export function mergeReviewQueuePages(
  previous: ReviewQueuePage | null,
  next: ReviewQueuePage,
): ReviewQueuePage {
  if (previous && previous.scopeKey !== next.scopeKey)
    throw new ReviewQueueError(
      'scope_changed',
      '작업 공간의 조회 범위가 변경되어 이전 목록을 숨겼습니다.',
    );
  if (
    previous &&
    (previous.snapshotRevision !== next.snapshotRevision ||
      previous.totalItems !== next.totalItems)
  )
    throw new ReviewQueueError(
      'snapshot_changed',
      '검토 목록의 기준이 변경되었습니다. 새로고침해 주세요.',
    );
  const merged = new Map<string, ReviewQueueItem>();
  for (const item of [...(previous?.items ?? []), ...next.items])
    merged.set(item.key, item);
  const items = [...merged.values()];
  if (
    items.length > next.totalItems ||
    (next.nextCursor === null && items.length !== next.totalItems)
  )
    throw new ReviewQueueError(
      'snapshot_changed',
      '검토 목록의 전체 건수를 확인할 수 없습니다. 새로고침해 주세요.',
    );
  const skipped = new Map<string, ReviewQueuePage['skipped'][number]>();
  for (const item of [...(previous?.skipped ?? []), ...next.skipped])
    skipped.set(JSON.stringify([item.kind, item.reference, item.code]), item);
  return {
    ...next,
    items,
    scopeComplete: next.scopeComplete && (previous?.scopeComplete ?? true),
    complete: next.complete && (previous?.scopeComplete ?? true),
    truncated: next.truncated || (previous?.truncated ?? false),
    skipped: [...skipped.values()],
    messages: [...new Set([...(previous?.messages ?? []), ...next.messages])],
    hiddenCorrespondenceCount: items.filter(
      (item: ReviewQueueItem): boolean =>
        item.kind === 'correspondence_judgment',
    ).length,
  };
}
