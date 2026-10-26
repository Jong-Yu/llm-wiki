import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';
import { knowledgeValueSchema } from './knowledge.contract';
import { isDocumentPath } from './documents.contract';

export const RESULT_DRAFT_CHANNELS: {
  readonly execute: 'result-drafts:execute';
} = {
  execute: 'result-drafts:execute',
};
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const scope = {
  connectionId: z.string().min(1).max(4096),
  expectedScope: workspaceScopeSchema,
};
export const resultDraftRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...scope,
    operation: z.literal('list'),
    input: z.strictObject({
      limit: z.number().int().min(1).max(50),
      cursor: z.string().min(1).max(16384).nullable(),
    }),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('read'),
    input: z.strictObject({ draft_id: id }),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('create'),
    input: z.strictObject({ request_id: id, saved_result_id: id }),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('edit'),
    input: z.strictObject({
      draft_id: id,
      request_id: id,
      expected_revision: revision,
      title: z.string().min(1).max(200),
      content: z.string().max(1024 * 1024),
    }),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('apply'),
    input: z.strictObject({
      draft_id: id,
      request_id: id,
      expected_revision: revision,
      document: z.string().min(1).max(4096).refine(isDocumentPath),
      expected_document_revision: revision.nullable(),
      expected_basis_observation: revision,
      acknowledge_changed_basis: z.boolean(),
    }),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('receipt'),
    input: z.strictObject({ request_id: id, record_id: id.optional() }),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('applicationReceipt'),
    input: z.strictObject({ draft_id: id, request_id: id }),
  }),
]);
export type ResultDraftRequest = z.infer<typeof resultDraftRequestSchema>;
export const resultDraftResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      connectionId: scope.connectionId,
      operation: z.enum([
        'list',
        'read',
        'create',
        'edit',
        'apply',
        'receipt',
        'applicationReceipt',
      ]),
      data: knowledgeValueSchema,
      access: workspaceScopeSchema,
      traceId: id,
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4096),
      status: z.number().optional(),
      traceId: id.optional(),
      retry: z
        .enum(['none', 'read_again', 'same_basis', 'reconcile'])
        .optional(),
      cleanupWarningCount: z.number().int().min(0).optional(),
    }),
  }),
]);
export type ResultDraftResult = z.infer<typeof resultDraftResultSchema>;
export type ResultDraftBridge = {
  execute: (request: ResultDraftRequest) => Promise<ResultDraftResult>;
};
/** preload 응답에서 공개 계약 외의 값과 비밀 필드를 제거합니다. */
export function parseResultDraftResult(value: unknown): ResultDraftResult {
  return resultDraftResultSchema.parse(value);
}
