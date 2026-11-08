import type {
  DocumentListItem,
  DocumentListPage,
} from '@contracts/documents.contract';

export type LibraryScope = DocumentListPage['access'] & {
  connectionId: string;
};
export type ExtractionState = 'ready' | 'stale' | 'missing' | 'unknown';
export type LibraryRow = {
  item: DocumentListItem;
  snippet: string | null;
  extraction: ExtractionState;
  extractionMessage: string | null;
  relationCount: number | null;
};
export type LibraryResult = {
  scope: LibraryScope;
  rows: LibraryRow[];
  nextCursor: string | null;
  incomplete: boolean;
  skipped: DocumentListPage['skipped'];
  requiresRefresh: boolean;
};
export type LibraryOutcome =
  | { status: 'ready'; result: LibraryResult }
  | { status: 'unselected' }
  | {
      status: 'error';
      message: string;
      failure?: { code: string; message: string; status?: number };
    };
export type LibraryRequest = {
  query: string;
  cursor: string | null;
  previousCursors: readonly (string | null)[];
  expectedScope?: LibraryScope;
};

export type LibrarySourceItem = Extract<DocumentListItem, { kind: 'source' }>;
/** 이미 등록된 원본의 분석 시작·진행 확인입니다. feature 간 참조 금지로 페이지가 주입합니다. */
export type SourceAnalysisStarter = {
  start: (item: LibrarySourceItem) => Promise<{ ok: boolean; message: string }>;
  inFlight: (item: LibrarySourceItem) => boolean;
};
