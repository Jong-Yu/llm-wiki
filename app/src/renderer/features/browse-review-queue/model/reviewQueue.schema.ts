import { z } from 'zod';
import { isDocumentPath } from '@contracts/documents.contract';
import { knowledgeClaimSchema } from '@contracts/knowledge.contract';

const text = z.string().min(1).max(4096);
const key = z.string().min(1).max(8192);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
export const reviewStateSchema = z.enum(['unreviewed', 'defer', 'pending']);
const documentRef = z.object({
  kind: z.literal('document'),
  reference: text.refine(isDocumentPath),
  source_revision: revision,
  graph_revision: revision.nullable(),
  review_revision: revision.nullable(),
  history_revision: revision,
  state_revision: revision,
  status: text,
});
const correspondenceRef = z.object({
  kind: z.literal('correspondence'),
  reference: id,
  correspondence_revision: revision,
  state_revision: revision.nullable(),
  complete: z.boolean(),
});
const item = z.discriminatedUnion('kind', [
  z.object({
    key,
    kind: z.literal('document_claim'),
    status: z.enum(['unreviewed', 'defer']),
    ref: documentRef,
    claim: knowledgeClaimSchema,
  }),
  z.object({
    key,
    kind: z.literal('pending_document_event'),
    status: z.literal('pending'),
    ref: documentRef,
    event_id: id,
  }),
  z.object({
    key,
    kind: z.literal('document_graph'),
    status: z.literal('pending'),
    ref: documentRef,
    graph_status: text,
  }),
  z.object({
    key,
    kind: z.literal('correspondence_judgment'),
    status: reviewStateSchema,
    ref: correspondenceRef,
    judgment: z.object({ event_id: id }).catchall(z.json()),
  }),
]);

// 서버의 자료별 판본과 불완전 상태를 검증하며 임의의 빈 정상 목록으로 바꾸지 않습니다.
export const reviewQueueSchema = z.object({
  kind: z.literal('review_queue'),
  scope: z.object({
    tenant: text,
    coverage: z.literal('tenant_visible_resources'),
    states: z.array(reviewStateSchema).min(1).max(3),
    job_visibility: z.literal('current_user_only'),
    order: z.literal('resource_reference'),
  }),
  items: z.array(item).max(100),
  resources: z.array(z.union([documentRef, correspondenceRef])).max(2000),
  snapshot_revision: revision,
  consistency: z.literal('per_resource_snapshots'),
  total_items: z.number().int().min(0).max(2000),
  next_cursor: z.string().min(1).max(16384).nullable(),
  scope_complete: z.boolean(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.object({ kind: text, reference: text, code: text })),
  requires_refresh: z.boolean(),
});

export type ReviewQueueResponse = z.infer<typeof reviewQueueSchema>;
export type ReviewQueueResponseItem = ReviewQueueResponse['items'][number];
