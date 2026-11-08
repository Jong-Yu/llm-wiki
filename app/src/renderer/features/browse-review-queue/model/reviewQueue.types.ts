export type ReviewQueueState = 'unreviewed' | 'defer' | 'pending';
export type ReviewQueueKind =
  | 'document_claim'
  | 'pending_document_event'
  | 'document_graph'
  | 'correspondence_judgment';

export type ReviewQueueItem = {
  key: string;
  kind: ReviewQueueKind;
  status: ReviewQueueState;
  statusLabel: string;
  title: string;
  excerpt?: string;
  detail: string;
  evidence?: { quote: string; location: string | null };
  reference: string;
  /** document_claim 항목의 주장 ID(검토 위젯이 대상 주장을 찾는 데 씁니다). */
  claimId?: string;
  document: string | null;
  href: string | null;
  actionLabel: string | null;
};

export type ReviewQueueSkipped = {
  kind: string;
  reference: string;
  code: string;
};

export type ReviewQueuePage = {
  scopeKey: string;
  items: ReviewQueueItem[];
  nextCursor: string | null;
  totalItems: number;
  snapshotRevision: string;
  scopeComplete: boolean;
  complete: boolean;
  truncated: boolean;
  skipped: ReviewQueueSkipped[];
  requiresRefresh: boolean;
  messages: string[];
  hiddenCorrespondenceCount: number;
};
