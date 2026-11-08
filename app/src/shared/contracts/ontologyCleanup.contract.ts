import { z } from 'zod';
import { isDocumentPath } from './documents.contract';
import { knowledgeValueSchema } from './knowledge.contract';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const document = z.string().refine(isDocumentPath);
const scope = z.object({
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
});
export const cleanupItemSchema = z.object({
  item_id: revision,
  kind: z.enum(['archive_rejected', 'archive_pending_review']),
  available: z.literal(true),
  reason: z.string(),
  claim_id: revision,
  event_id: id,
  collection: z.enum(['relations', 'relation_candidates']),
  decision: z.string(),
  target: knowledgeValueSchema,
});
export type CleanupItem = z.infer<typeof cleanupItemSchema>;
const page = {
  document,
  state_revision: revision,
  total_items: z.number().int().nonnegative(),
  next_cursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.json()),
  requires_refresh: z.boolean(),
};
export const cleanupPreviewSchema = z.object({
  ...page,
  scope,
  preview_revision: revision,
  status: z.string(),
  capabilities: z.array(
    z.object({
      kind: z.string(),
      available: z.boolean(),
      reason: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  items: z.array(cleanupItemSchema),
});
export type CleanupPreview = z.infer<typeof cleanupPreviewSchema>;
export const cleanupEventSchema = z.object({
  id,
  action: z.enum(['cleanup_apply', 'cleanup_undo']),
  request_id: id,
  request_hash: revision,
  actor: knowledgeValueSchema,
  scope,
  timestamp: z.string(),
  reason: z.string(),
  base_state_revision: revision,
  source_revision: revision,
  graph_revision: revision.nullable(),
  history_revision: revision,
  items: z.array(cleanupItemSchema),
  undo_of: id.nullable(),
  previous_hash: z.string().nullable(),
  hash: revision,
});
export type CleanupEvent = z.infer<typeof cleanupEventSchema>;
export const cleanupHistorySchema = z.object({
  ...page,
  items: z.array(cleanupEventSchema),
});
export type CleanupHistory = z.infer<typeof cleanupHistorySchema>;
export const cleanupReceiptSchema = z.object({
  document,
  request_id: id,
  event_id: id,
  event: cleanupEventSchema,
  saved: z.literal(true),
  changed: z.boolean(),
  replayed: z.boolean(),
  state_revision: revision,
  cleanup_failures: z.array(z.json()),
  retry_policy: z.literal('read_receipt'),
});
export type CleanupReceipt = z.infer<typeof cleanupReceiptSchema>;
