import { z } from 'zod';
import { documentListPageSchema, isDocumentPath } from './documents.contract';

export const KNOWLEDGE_CHANNELS = { read: 'knowledge:read' } as const;
const text = z.string().min(1).max(4096);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const json = z.json();
export const knowledgeValueSchema = z.record(z.string(), json);
export type KnowledgeJson = z.infer<typeof json>;
export type KnowledgeValue = z.infer<typeof knowledgeValueSchema>;

// 스키마 세대별 한정어·속성·출처 필드는 catchall로 원형을 보존합니다.
export const knowledgeEntitySchema = z
  .object({ id: text, label: text, type: text })
  .catchall(json);
export const knowledgeGraphSchema = z
  .object({
    status: text,
    entities: z.array(knowledgeEntitySchema),
    relations: z.array(knowledgeValueSchema),
    attributes: z.array(knowledgeValueSchema),
    relation_candidates: z.array(knowledgeValueSchema),
  })
  .catchall(json);
export const knowledgeClaimSchema = z
  .object({
    claim_id: revision,
    collection: z.enum(['relations', 'attributes', 'relation_candidates']),
    value: knowledgeValueSchema,
    reviewed_value: knowledgeValueSchema,
    decision: text,
    review_event_id: z.string().nullable(),
    ambiguous: z.boolean(),
    needs_review: z.boolean(),
  })
  .catchall(json);
export type KnowledgeClaim = z.infer<typeof knowledgeClaimSchema>;
export type KnowledgeEntity = z.infer<typeof knowledgeEntitySchema>;
export const knowledgeRequestSchema = z.strictObject({
  connectionId: text,
  document: text.refine(isDocumentPath),
});
const rawAccess = z.object({
  user_id: text,
  tenant: text,
  profile_id: text,
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: revision,
  access_revision: z
    .string()
    .min(1)
    .nullish()
    .transform(
      (value: string | null | undefined): string | undefined =>
        value ?? undefined,
    ),
});
const rawKnowledge = z.object({
  document: text.refine(isDocumentPath),
  source_revision: revision,
  graph_revision: revision.nullable(),
  review_revision: revision.nullable(),
  history_revision: revision,
  state_revision: revision,
  status: text,
  machine_graph: knowledgeGraphSchema,
  effective_graph: knowledgeGraphSchema,
  claims: z.array(knowledgeClaimSchema),
  current_claims: z.array(knowledgeClaimSchema).optional(),
  current_pending_history: z.array(text).optional(),
  cleanup: knowledgeValueSchema.optional(),
  authored_relations: z.array(knowledgeValueSchema).optional(),
  relation_history: z.array(knowledgeValueSchema).optional(),
  policies: z.array(knowledgeValueSchema),
  history: z.array(knowledgeValueSchema),
  pending_history: z.array(text),
  selection: knowledgeValueSchema,
  needs_review: z.boolean(),
  access: rawAccess,
});
const envelope = z.object({
  data: rawKnowledge,
  meta: z.object({ trace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
});
export const documentKnowledgeSchema = z.object({
  connectionId: text,
  document: text.refine(isDocumentPath),
  sourceRevision: revision,
  graphRevision: revision.nullable(),
  reviewRevision: revision.nullable(),
  historyRevision: revision,
  stateRevision: revision,
  status: text,
  machineGraph: knowledgeGraphSchema,
  effectiveGraph: knowledgeGraphSchema,
  claims: z.array(knowledgeClaimSchema),
  currentClaims: z.array(knowledgeClaimSchema).optional(),
  currentPendingHistory: z.array(text).optional(),
  cleanup: knowledgeValueSchema.optional(),
  authoredRelations: z.array(knowledgeValueSchema).optional(),
  relationHistory: z.array(knowledgeValueSchema).optional(),
  policies: z.array(knowledgeValueSchema),
  history: z.array(knowledgeValueSchema),
  pendingHistory: z.array(text),
  selection: knowledgeValueSchema,
  needsReview: z.boolean(),
  access: documentListPageSchema.shape.access,
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
});
const result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: documentKnowledgeSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().regex(/^[a-z0-9_]{1,128}$/),
      message: text,
      status: z.number().int().min(100).max(599).optional(),
      traceId: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
    }),
  }),
]);
export type DocumentKnowledgeRequest = z.infer<typeof knowledgeRequestSchema>;
export type DocumentKnowledge = z.infer<typeof documentKnowledgeSchema>;
export type DocumentKnowledgeResult = z.infer<typeof result>;
export type KnowledgeBridge = {
  read: (request: DocumentKnowledgeRequest) => Promise<DocumentKnowledgeResult>;
};

/** 현재 연결과 검증된 상대 문서 경로만 허용하고 주소/관점 주입을 막습니다. */
export function parseDocumentKnowledgeRequest(
  value: unknown,
): DocumentKnowledgeRequest {
  return knowledgeRequestSchema.parse(value);
}

/** 전체 기계층·유효층·검토/정책 이력을 보존하며 서버 외곽 필드만 매핑합니다. */
export function parseDocumentKnowledgeResponse(
  value: unknown,
  connectionId: string,
): DocumentKnowledge {
  const { data, meta } = envelope.parse(value);
  return {
    connectionId,
    document: data.document,
    sourceRevision: data.source_revision,
    graphRevision: data.graph_revision,
    reviewRevision: data.review_revision,
    historyRevision: data.history_revision,
    stateRevision: data.state_revision,
    status: data.status,
    machineGraph: data.machine_graph,
    effectiveGraph: data.effective_graph,
    claims: data.claims,
    currentClaims: data.current_claims,
    currentPendingHistory: data.current_pending_history,
    cleanup: data.cleanup,
    authoredRelations: data.authored_relations,
    relationHistory: data.relation_history,
    policies: data.policies,
    history: data.history,
    pendingHistory: data.pending_history,
    selection: data.selection,
    needsReview: data.needs_review,
    access: {
      userId: data.access.user_id,
      tenant: data.access.tenant,
      profileId: data.access.profile_id,
      domain: data.access.domain,
      viewpoint: data.access.viewpoint,
      policyRevision: data.access.policy_revision,
      ...(data.access.access_revision
        ? { accessRevision: data.access.access_revision }
        : {}),
    },
    traceId: meta.trace_id,
  };
}

/** preload는 지식 응답을 다시 검사하고 비공개 값을 공개 구조에 추가하지 않습니다. */
export function parseDocumentKnowledgeResult(
  value: unknown,
): DocumentKnowledgeResult {
  return result.parse(value);
}
