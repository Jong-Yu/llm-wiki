import { z } from 'zod';
import { isDocumentPath } from './documents.contract';
import {
  knowledgeEntitySchema,
  knowledgeValueSchema,
} from './knowledge.contract';

const text = z.string().min(1).max(4096);
const document = text.refine(isDocumentPath);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(16384).nullable();
const origin = z.enum(['machine', 'reviewed', 'policy', 'independent']);
const qualifications = {
  polarity: text.nullable(),
  modality: text.nullable(),
  conditional: z.boolean(),
};

/** 검색·최근 항목은 같은 서버 색인에서 찾고 임의 HTTP 범위를 받지 않습니다. */
export const ontologySearchInputSchema = z.strictObject({
  text: z.string().max(200).optional(),
  kind: z.enum(['all', 'concept', 'document']).optional(),
  document: document.optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type OntologySearchInput = z.infer<typeof ontologySearchInputSchema>;

/** 선택 당시 state를 함께 보내 판본이 달라진 이웃의 누적을 막습니다. */
export const ontologyNeighborsInputSchema = z.strictObject({
  document,
  entity_id: text,
  expected_state_revision: revision,
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type OntologyNeighborsInput = z.infer<
  typeof ontologyNeighborsInputSchema
>;

export const ontologyDocumentRefSchema = z.strictObject({
  document,
  kind: z.literal('document'),
  reference: document,
  source_revision: revision.nullable(),
  graph_revision: revision.nullable(),
  review_revision: revision.nullable(),
  history_revision: revision.nullable(),
  state_revision: revision.nullable(),
  status: text,
});
export type OntologyDocumentRef = z.infer<typeof ontologyDocumentRefSchema>;

const entityRef = z.strictObject({ document, entity_id: text });
const anchorRef = z.strictObject({ document, anchor_id: revision });
export const ontologyMapEndpointSchema = z.union([entityRef, anchorRef]);
export type OntologyMapEndpoint = z.infer<typeof ontologyMapEndpointSchema>;
export const ontologyMapConceptSchema = entityRef.extend({
  name: text,
  type: text,
  attribute_count: count,
  ref: ontologyDocumentRefSchema,
});
export type OntologyMapConcept = z.infer<typeof ontologyMapConceptSchema>;

const sourceAnchorSummary = anchorRef.extend({
  source_revision: revision,
  start_line: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024),
  end_line: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024),
  occurrence: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024),
  ref: ontologyDocumentRefSchema,
});
/** 경량 원문 노드는 위치만 전달하며 원문 인용은 판본을 확인한 문서 상세에서 읽습니다. */
export const ontologyMapSourceAnchorSchema = sourceAnchorSummary.refine(
  (anchor: z.infer<typeof sourceAnchorSummary>): boolean =>
    anchor.document === anchor.ref.document &&
    anchor.document === anchor.ref.reference &&
    anchor.source_revision === anchor.ref.source_revision &&
    anchor.end_line >= anchor.start_line,
  {
    message:
      'Source anchor summary must match its document revision and line range',
  },
);
export type OntologyMapSourceAnchor = z.infer<
  typeof ontologyMapSourceAnchorSchema
>;

export const ontologyMapEdgeSchema = z.strictObject({
  key: text,
  document,
  subject: ontologyMapEndpointSchema,
  object: ontologyMapEndpointSchema,
  label: text,
  origin,
  collection: text,
  original_collection: text,
  claim_id: revision.nullable(),
  collection_index: count.nullable(),
  ...qualifications,
  ref: ontologyDocumentRefSchema,
});
export type OntologyMapEdge = z.infer<typeof ontologyMapEdgeSchema>;

export const ontologyMapPreviewSchema = z.strictObject({
  label: text,
  other_name: text,
  direction: z.enum(['incoming', 'outgoing']),
  origin,
  ...qualifications,
});
export type OntologyMapPreview = z.infer<typeof ontologyMapPreviewSchema>;

export const ontologySearchItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('concept'),
    concept: ontologyMapConceptSchema,
    concept_count: count,
    relation_count: count,
    previews: z.array(ontologyMapPreviewSchema).max(2),
  }),
  z.strictObject({
    kind: z.literal('document'),
    ref: ontologyDocumentRefSchema,
    title: text,
    concept_count: count,
    relation_count: count,
    concepts: z.array(ontologyMapConceptSchema).max(5),
    previews: z.array(ontologyMapPreviewSchema).max(2),
  }),
]);
export type OntologySearchItem = z.infer<typeof ontologySearchItemSchema>;

const coverage = z.strictObject({
  complete: z.boolean(),
  skipped: z.array(z.strictObject({ document, code: text })),
  truncated: z.boolean(),
});
const access = z.strictObject({
  user_id: text,
  tenant: text,
  profile_id: text,
  domain: z.string().max(4096).nullable(),
  viewpoint: z.string().max(4096).nullable(),
  policy_revision: revision,
  access_revision: text.nullish(),
});
const page = {
  index_revision: revision,
  next_cursor: cursor,
  total: count,
  coverage,
  access,
};

/** 전체 지식·인용 없이 검색에 필요한 실제 개념과 부분 범위만 검사합니다. */
export const ontologySearchPageSchema = z.strictObject({
  ...page,
  items: z.array(ontologySearchItemSchema).max(50),
});
export type OntologySearchPage = z.infer<typeof ontologySearchPageSchema>;

const ontologyNeighborPage = z.strictObject({
  ...page,
  document: ontologyDocumentRefSchema,
  entity_id: text,
  concepts: z.array(ontologyMapConceptSchema),
  anchors: z.array(ontologyMapSourceAnchorSchema).max(100).default([]),
  edges: z.array(ontologyMapEdgeSchema).max(50),
});
/** 원문 위치도 같은 문서·판본의 별도 끝점으로 검사하며 개체 ID로 취급하지 않습니다. */
export const ontologyNeighborPageSchema = ontologyNeighborPage.refine(
  (value: z.infer<typeof ontologyNeighborPage>): boolean => {
    const anchors = new Set(
      value.anchors.map(
        (anchor: OntologyMapSourceAnchor): string => anchor.anchor_id,
      ),
    );
    return (
      anchors.size === value.anchors.length &&
      value.anchors.every(
        (anchor: OntologyMapSourceAnchor): boolean =>
          anchor.document === value.document.document &&
          anchor.ref.state_revision !== null &&
          anchor.ref.state_revision === value.document.state_revision &&
          anchor.source_revision === value.document.source_revision,
      ) &&
      value.edges.every((edge: OntologyMapEdge): boolean =>
        [edge.subject, edge.object].every(
          (endpoint: OntologyMapEndpoint): boolean =>
            endpoint.document === value.document.document &&
            (!('anchor_id' in endpoint) || anchors.has(endpoint.anchor_id)),
        ),
      )
    );
  },
  {
    message:
      'Neighbor source anchors must belong to this document and page revision',
  },
);
export type OntologyNeighborPage = z.infer<typeof ontologyNeighborPageSchema>;

/** 선택한 개체의 원문 문맥만 읽으며 별도 생성·저장 입력을 허용하지 않습니다. */
export const ontologyGlossaryInputSchema = z.strictObject({
  document,
  entity_id: text,
  expected_state_revision: revision,
  limit: z.number().int().min(1).max(20).optional(),
});
export type OntologyGlossaryInput = z.infer<typeof ontologyGlossaryInputSchema>;

const glossaryClaim = z.strictObject({
  claim_id: revision,
  collection: z.enum(['attributes', 'relations', 'relation_candidates']),
  original_collection: z.enum([
    'attributes',
    'relations',
    'relation_candidates',
  ]),
  origin,
  decision: text,
  value: knowledgeValueSchema,
  provenance: knowledgeValueSchema,
});

/** 요약 정의 대신 현재 개체·원문 문단·주장의 출처와 한정어를 보존합니다. */
export const ontologyGlossaryCardSchema = z.strictObject({
  document: ontologyDocumentRefSchema,
  entity: knowledgeEntitySchema,
  source_passage: z
    .strictObject({
      quote: z.string().min(1),
      start_line: z.number().int().min(1),
      end_line: z.number().int().min(1),
      source_revision: revision,
    })
    .nullable(),
  source_passage_status: z.enum(['available', 'no_source_evidence', 'limited']),
  attributes: z.array(glossaryClaim).max(20),
  relations: z.array(glossaryClaim).max(20),
  totals: z.strictObject({ attributes: count, relations: count }),
  coverage,
  access,
});
export type OntologyGlossaryCard = z.infer<typeof ontologyGlossaryCardSchema>;
