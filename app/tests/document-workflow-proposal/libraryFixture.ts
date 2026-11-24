import { useState } from 'react';
import type {
  LibraryRow,
  LibraryRequest,
  LibrarySourceItem,
  LibraryScope,
} from '@renderer/features/browse-document-library/model/documentLibrary.types';
import type { SourceAnalysisView } from '@renderer/features/browse-document-library/model/useSourceAnalysis';
import { proposed, usePreviewTasks, sourceTaskPath } from './previewStore';
import type { PreviewTask } from './model';

export const scope: LibraryScope = {
  connectionId: 'fixture',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  domain: null,
  viewpoint: null,
  policyRevision: 'e'.repeat(64),
};
export const libraryNavigation = {
  request: { query: '', cursor: null, previousCursors: [] } as LibraryRequest,
  query: '',
  filter: 'all',
  selected: null as string | null,
};
export function rememberLibraryNavigation(
  query: string,
  filter: string,
  selected: string,
): void {
  Object.assign(libraryNavigation, { query, filter, selected });
}
export function sourceItem(task: PreviewTask): LibrarySourceItem {
  return {
    kind: 'source',
    sourceId: task.sourceId,
    sourceVersion: task.version,
    sourceSha256: 'e'.repeat(64),
    registrationRevision: 'e'.repeat(64),
    title: task.title,
    sizeBytes: task.id === 'architecture' ? 8225322 : 204800,
    format: task.fileName.endsWith('.pdf')
      ? 'pdf'
      : task.fileName.endsWith('.docx')
        ? 'docx'
        : task.fileName.endsWith('.txt')
          ? 'txt'
          : 'md',
    linkedDocumentCount: task.savedWiki ? 1 : 0,
    analysisStatus: 'not_started',
  };
}
/** 목록 조작은 동일한 합성 자료를 좁히며 실제 문서 목록 UI를 그대로 사용합니다. */
export function useDocumentLibrary(): {
  state: {
    status: 'ready';
    result: {
      scope: LibraryScope;
      rows: LibraryRow[];
      nextCursor: null;
      incomplete: false;
      skipped: [];
      requiresRefresh: false;
    };
  };
  refreshing: boolean;
  refreshError: null;
  request: LibraryRequest;
  search: (query: string) => void;
  refresh: () => void;
  revalidate: () => void;
  next: () => void;
  previous: () => void;
} {
  const tasks = usePreviewTasks();
  const [query, setQuery] = useState(libraryNavigation.query);
  const noop = (): void => {};
  const rows: LibraryRow[] = tasks
    .filter((task: PreviewTask): boolean => task.title.includes(query))
    .map((task: PreviewTask): LibraryRow => ({
      item: sourceItem(task),
      snippet: null,
      extraction: 'unknown',
      extractionMessage: null,
      relationCount: null,
    }));
  return {
    state: {
      status: 'ready',
      result: {
        scope,
        rows,
        nextCursor: null,
        incomplete: false,
        skipped: [],
        requiresRefresh: false,
      },
    },
    refreshing: false,
    refreshError: null,
    request: { query, cursor: null, previousCursors: [] },
    search: setQuery,
    refresh: noop,
    revalidate: noop,
    next: noop,
    previous: noop,
  };
}
/** before는 현재 요약 규칙, after는 같은 작업의 구체 상태·주소를 표시합니다. */
export function useSourceAnalysis(): {
  viewOf: (item: LibrarySourceItem) => SourceAnalysisView;
  start: (item: LibrarySourceItem) => Promise<void>;
  message: null;
} {
  const tasks = usePreviewTasks();
  return {
    viewOf: (item: LibrarySourceItem): SourceAnalysisView => {
      const task = tasks.find(
        (candidate: PreviewTask): boolean =>
          candidate.sourceId === item.sourceId,
      );
      if (!task) return { kind: 'unknown', jobId: null, progressPath: null };
      const kind =
        task.state === 'running'
          ? 'running'
          : task.state === 'complete' || (!proposed && task.previousSuccess)
            ? 'complete'
            : task.state === 'ready'
              ? 'pending'
              : 'attention';
      return {
        kind,
        jobId: !proposed && task.phase !== 'conversion' ? task.sourceId : null,
        progressPath: proposed
          ? sourceTaskPath(item.sourceId)
          : task.phase === 'conversion'
            ? `/register?sourceId=${task.sourceId}&version=${task.version}`
            : null,
      };
    },
    start: async (): Promise<void> => {},
    message: null,
  };
}
