import type {
  DocumentKnowledge,
  KnowledgeValue,
} from '@contracts/knowledge.contract';

export type ReviewSelection = {
  document: string;
  claimId: string;
  stateRevision: string;
  collection: 'relations' | 'attributes' | 'relation_candidates';
  value: KnowledgeValue;
  reviewedValue?: KnowledgeValue;
  title?: string;
  ambiguous?: boolean;
};
export type ReviewScope = {
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
  domain?: string | null;
  viewpoint?: string | null;
};
export type ReviewContext = {
  knowledge: DocumentKnowledge;
  body: string;
  bodyRevision: string;
  permissions: string[];
};
export type ReviewError = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
};
export type ReviewEventPage = {
  items: KnowledgeValue[];
  nextCursor: string | null;
  stateRevision: string;
  pendingHistory: string[];
  complete: boolean;
  truncated: boolean;
  skippedCount: number;
  requiresRefresh: boolean;
};
export type ReviewEventDetail = {
  event: KnowledgeValue;
  stateRevision: string;
  pending: boolean;
};
export type ReviewMutation = {
  eventId: string;
  stateRevision: string;
  cleanupWarningCount: number;
};
export type ReviewOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: ReviewError };
