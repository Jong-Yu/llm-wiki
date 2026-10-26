import { z } from 'zod';
import type { DocumentListItem } from './useDocumentList';

export const catalogFiltersSchema = z.object({
  query: z.string().max(300),
  folder: z.string().max(4096),
  kind: z.enum(['all', 'source', 'wiki']),
});
export type CatalogFilters = z.infer<typeof catalogFiltersSchema>;
export type DocumentPanelTab =
  | 'body'
  | 'knowledge'
  | 'connections'
  | 'versions'
  | 'conversion';

/** 페이지를 바꿀 때 이전 페이지의 필터를 가져오지 않습니다. */
export function createCatalogFilters(): CatalogFilters {
  return { query: '', folder: '', kind: 'all' };
}

/** 원본과 위키의 실제 식별 범위를 구분하는 표시용 선택 키입니다. */
export function documentItemKey(item: DocumentListItem): string {
  return item.kind === 'wiki'
    ? `wiki:${item.document}`
    : `source:${item.sourceId}:${item.sourceVersion}`;
}

/** API에 실제로 있는 제목 또는 위키 경로만 표시합니다. */
export function documentItemTitle(item: DocumentListItem): string {
  return item.kind === 'wiki' ? item.document : item.title;
}

/** 원본 API에 없는 폴더를 추정하지 않고 위키 경로에서만 폴더를 찾습니다. */
export function wikiFolder(document: string): string {
  const separator = document.lastIndexOf('/');
  return separator < 0 ? '/' : document.slice(0, separator);
}

/** 현재 페이지에서 확인한 위키 폴더만 필터 선택지로 사용합니다. */
export function catalogFolders(items: readonly DocumentListItem[]): string[] {
  const folders = new Set<string>();
  for (const item of items)
    if (item.kind === 'wiki') folders.add(wikiFolder(item.document));
  return [...folders].sort();
}

/** 로컬 필터는 현재 페이지의 제목/경로만 검사하며 서버 전체 검색을 하지 않습니다. */
export function filterCatalog(
  items: readonly DocumentListItem[],
  filters: CatalogFilters,
): DocumentListItem[] {
  const query = filters.query.trim().toLocaleLowerCase('ko-KR');
  return items.filter((item: DocumentListItem): boolean => {
    if (filters.kind !== 'all' && item.kind !== filters.kind) return false;
    if (
      filters.folder &&
      (item.kind !== 'wiki' || wikiFolder(item.document) !== filters.folder)
    )
      return false;
    return (
      query === '' ||
      documentItemTitle(item).toLocaleLowerCase('ko-KR').includes(query)
    );
  });
}
