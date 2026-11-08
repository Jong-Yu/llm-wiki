import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';
import { isDocumentPath } from './documents.contract';
import { knowledgeValueSchema } from './knowledge.contract';

export const KNOWLEDGE_COMPARISON_CHANNELS = {
  list: 'knowledge-comparisons:list',
  read: 'knowledge-comparisons:read',
  restart: 'knowledge-comparisons:restart',
  stopLocal: 'knowledge-comparisons:stop-local',
} as const;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const scope = {
  connectionId: z.string().min(1),
  expectedScope: workspaceScopeSchema,
};
export const knowledgeComparisonListSchema = z.strictObject({
  ...scope,
  document: z.string().refine(isDocumentPath).nullable().default(null),
  jobId: id.nullable().default(null),
  /** 이전 페이지가 돌려준 이어 읽기 값입니다. 처음 읽을 때는 비웁니다. */
  cursor: z.string().min(1).max(16384).nullable().default(null),
});
export const knowledgeComparisonReadSchema = z.strictObject({
  ...scope,
  comparisonId: id,
});
export const knowledgeComparisonRestartSchema =
  knowledgeComparisonReadSchema.extend({ expectedRevision: revision });
export const comparisonItemSchema = z.object({
  id,
  document: z.string(),
  job_id: id.nullable(),
  created_at: z.string(),
  status: z.enum(['running', 'complete', 'incomplete']),
  revision,
});
export const comparisonCandidateSchema = z.object({
  reference_id: revision,
  reason: z.string(),
  unconfirmed: z.array(z.string()),
});
export const comparisonReferenceSchema = z.object({
  reference_id: revision,
  target_ref: knowledgeValueSchema,
  document: z.string().nullable().optional(),
  matched_terms: z.array(z.string()),
  matched_fields: z.array(
    z.object({ field: z.string(), expression: z.string() }),
  ),
  review_status: z.unknown().optional(),
  policy_status: z.unknown().optional(),
  currentness: z.unknown().optional(),
  provenance: z.unknown().optional(),
});
export const comparisonDetailSchema = z.object({
  coverage: z
    .object({
      complete: z.boolean(),
      truncated: z.boolean(),
      lookup_limit_reached: z.boolean(),
      seed_terms_truncated: z.boolean(),
      semantic_coverage: z.literal('not_guaranteed'),
      skipped: z.array(z.unknown()),
    })
    .optional(),
  record: z.object({
    id,
    kind: z.literal('knowledge-comparisons'),
    user_id: z.string(),
    tenant: z.string(),
    data: z.object({
      document: z.string(),
      job_id: id.nullable(),
      session_id: z.string(),
      provider: z.enum(['codex', 'claude']).nullish(),
      basis: knowledgeValueSchema,
      seed_terms: z.array(z.string()),
    }),
    events: z.array(knowledgeValueSchema),
  }),
  revision,
  status: z.enum(['running', 'complete', 'incomplete']),
  lookup_count: z.number().int().min(0).max(5),
  lookup_limit: z.literal(5),
  result: z
    .object({
      candidates: z.array(comparisonCandidateSchema),
      excluded: z.array(comparisonCandidateSchema),
      unconfirmed: z.array(z.string()),
      failure: z.string().nullable(),
      unassessed_reference_ids: z.array(z.string()).optional(),
    })
    .nullable(),
  references: z.array(comparisonReferenceSchema),
  currentness: z.object({
    status: z.enum(['current', 'needs_recheck']),
    changed: z.array(z.unknown()),
    unavailable: z.array(z.unknown()),
  }),
});
export const comparisonLocalSchema = z.object({
  status: z.enum([
    'idle',
    'running',
    'stopping',
    'unconfirmed',
    'exited',
    'failed',
  ]),
  message: z.string(),
  requestId: id.nullable(),
  resultId: id.nullable(),
  cleanupWarning: z.boolean(),
});
const failure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().optional(),
    traceId: z.string().optional(),
  }),
});
export const knowledgeComparisonPageResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      items: z.array(comparisonItemSchema),
      latestId: id.nullable(),
      nextCursor: z.string().min(1).max(16384).nullable(),
      incomplete: z.boolean(),
    }),
  }),
  failure,
]);
export const knowledgeComparisonDetailResultSchema = z.discriminatedUnion(
  'ok',
  [
    z.object({
      ok: z.literal(true),
      data: z.object({
        comparison: comparisonDetailSchema,
        local: comparisonLocalSchema,
      }),
    }),
    failure,
  ],
);
export type KnowledgeComparisonListRequest = z.infer<
  typeof knowledgeComparisonListSchema
>;
export type KnowledgeComparisonReadRequest = z.infer<
  typeof knowledgeComparisonReadSchema
>;
export type KnowledgeComparisonRestartRequest = z.infer<
  typeof knowledgeComparisonRestartSchema
>;
export type KnowledgeComparisonPageResult = z.infer<
  typeof knowledgeComparisonPageResultSchema
>;
export type KnowledgeComparisonDetailResult = z.infer<
  typeof knowledgeComparisonDetailResultSchema
>;
export type KnowledgeComparisonDetail = z.infer<typeof comparisonDetailSchema>;
export type KnowledgeComparisonLocal = z.infer<typeof comparisonLocalSchema>;
export type KnowledgeComparisonItem = z.infer<typeof comparisonItemSchema>;
export type KnowledgeComparisonCandidate = z.infer<
  typeof comparisonCandidateSchema
>;
export type KnowledgeComparisonReference = z.infer<
  typeof comparisonReferenceSchema
>;
export type KnowledgeComparisonsBridge = {
  list: (
    request: KnowledgeComparisonListRequest,
  ) => Promise<KnowledgeComparisonPageResult>;
  read: (
    request: KnowledgeComparisonReadRequest,
  ) => Promise<KnowledgeComparisonDetailResult>;
  restart: (
    request: KnowledgeComparisonRestartRequest,
  ) => Promise<KnowledgeComparisonDetailResult>;
  stopLocal: (
    request: KnowledgeComparisonReadRequest,
  ) => Promise<KnowledgeComparisonDetailResult>;
};
/** 비교 목록은 서버의 실제 보관 결과만 전달합니다. */
export function parseKnowledgeComparisonPageResult(
  value: unknown,
): KnowledgeComparisonPageResult {
  return knowledgeComparisonPageResultSchema.parse(value);
}
/** 비교 결과와 로컬 실행 상태는 독립 검증해 저장 완료를 추정하지 않습니다. */
export function parseKnowledgeComparisonDetailResult(
  value: unknown,
): KnowledgeComparisonDetailResult {
  return knowledgeComparisonDetailResultSchema.parse(value);
}
