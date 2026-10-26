import { z } from 'zod';
import { documentListPageSchema, isDocumentPath } from './documents.contract';
import { knowledgeValueSchema } from './knowledge.contract';

export const WORKSPACE_CHANNELS = { execute: 'workspace:execute' } as const;
const text = z.string().min(1).max(4096);
const document = text.refine(isDocumentPath);
const connectionId = text;
export const workspaceScopeSchema = z.strictObject({
  userId: text,
  tenant: text,
  profileId: text,
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
const expectedScope = workspaceScopeSchema.optional();
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const cursor = z.string().min(1).max(16384).nullable().optional();
const documents = z.array(document).min(1).max(8);
const optionalDocuments = documents.nullable().optional();
const correspondenceIds = z.array(text).max(8).optional();
const limit = z.number().int().min(1).max(100).optional();
const historyId = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,250}\.md$/);
const documentInput = z.strictObject({ document });
const pageInput = z.strictObject({
  document,
  limit: z.number().int().min(1).max(50).optional(),
  cursor,
});
const aggregate = {
  documents,
  correspondence_ids: correspondenceIds,
  limit,
  cursor,
};
const conceptScope = {
  documents: optionalDocuments,
  application_context: knowledgeValueSchema.nullable().optional(),
  as_of: z.string().max(100).nullable().optional(),
  limit,
};
const claimBase = {
  document,
  claim_id: revision,
  expected_state_revision: revision,
  reason: z.string().min(1).max(1000),
};
const undoInput = z.strictObject({
  document,
  event_id: id,
  expected_state_revision: revision,
  reason: z.string().min(1).max(1000),
});
const content = z
  .string()
  .max(1024 * 1024)
  .refine(
    (value: string): boolean =>
      new TextEncoder().encode(value).byteLength <= 1024 * 1024,
    '본문은 UTF-8 1 MiB 이내여야 합니다.',
  );

const claimSelection = z.strictObject({
  document,
  claim_id: revision,
  state_revision: revision,
});
const questionContextInput = z.strictObject({
  documents: z.array(document).max(8).optional(),
  required_documents: z.array(document).max(8).optional(),
  claims: z.array(claimSelection).max(100).optional(),
  source_refs: z
    .array(
      z.strictObject({
        source_id: id,
        source_version: id,
        source_sha256: revision,
        conversion_ref: z
          .strictObject({ conversion_id: id, conversion_revision: revision })
          .optional(),
      }),
    )
    .max(4)
    .optional(),
});
const personalPage = z.strictObject({
  limit: z.number().int().min(1).max(50).optional(),
  cursor,
});
const recordInput = z.strictObject({ record_id: id });
const creation = { request_id: id, title: z.string().min(1).max(200) };
const changeReason = {
  expected_state_revision: revision,
  reason: z.string().min(1).max(1000),
};
const correspondenceScope = {
  application_context: knowledgeValueSchema.nullable().optional(),
  as_of: z.string().max(100).nullable().optional(),
};
const correspondenceUndo = z.strictObject({
  correspondence_id: id,
  event_id: id,
  ...changeReason,
});

/** 원본 전체·닫힌 줄/페이지 범위·시트/셀 위치를 서로 섞지 않습니다. */
const analysisRangeLocationSchema = z
  .strictObject({
    kind: z.enum(['whole', 'pages', 'lines', 'cells', 'blocks', 'paragraphs']),
    start: z.number().int().min(1).max(1_000_000).nullable().optional(),
    end: z.number().int().min(1).max(1_000_000).nullable().optional(),
    sheet: z.string().min(1).max(200).nullable().optional(),
    cells: z
      .string()
      .regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/)
      .nullable()
      .optional(),
  })
  .refine(
    (value: {
      kind: 'whole' | 'pages' | 'lines' | 'cells' | 'blocks' | 'paragraphs';
      start?: number | null;
      end?: number | null;
      sheet?: string | null;
      cells?: string | null;
    }): boolean => {
      if (
        value.kind === 'pages' ||
        value.kind === 'lines' ||
        value.kind === 'blocks' ||
        value.kind === 'paragraphs'
      )
        return (
          value.start != null &&
          value.end != null &&
          value.start <= value.end &&
          value.sheet == null &&
          value.cells == null
        );
      if (value.kind === 'cells')
        return (
          value.sheet != null &&
          value.cells != null &&
          value.start == null &&
          value.end == null
        );
      return (
        value.start == null &&
        value.end == null &&
        value.sheet == null &&
        value.cells == null
      );
    },
    '위치 종류에 맞는 전체·페이지/줄 범위 또는 시트/셀 범위를 지정해 주세요.',
  );
export const analysisLocationSchema = z.union([
  analysisRangeLocationSchema,
  z.strictObject({
    kind: z.literal('table_cells'),
    table: z.number().int().min(1),
    row: z.number().int().min(1),
    column: z.number().int().min(1),
  }),
]);
const analysisSourceRef = z.strictObject({
  source_id: id,
  source_version: id,
  source_sha256: revision,
  registration_revision: revision,
});
const analysisWikiRef = z.strictObject({
  document,
  source_revision: revision,
  graph_revision: revision.nullable(),
  state_revision: revision,
});
const analysisLocations = z.array(analysisLocationSchema).max(100);
const conversionUnit = z.strictObject({
  unit_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  location: analysisLocationSchema,
  content: z.string().max(4 * 1024 * 1024),
});
export const createConversionInputSchema = z
  .strictObject({
    request_id: id,
    source_ref: analysisSourceRef,
    method: z.enum(['verbatim', 'pdf_text', 'ocr', 'xlsx_values', 'docx_text']),
    units: z.array(conversionUnit).min(1).max(1000),
    complete: z.boolean(),
    unread_ranges: z.array(z.string().max(1000)).max(100).optional(),
    warnings: z.array(z.string().max(1000)).max(100).optional(),
  })
  .refine(
    (value: {
      units: z.infer<typeof conversionUnit>[];
      complete: boolean;
      unread_ranges?: string[];
    }): boolean =>
      (!value.complete || !value.unread_ranges?.length) &&
      new Set(
        value.units.map(
          (unit: z.infer<typeof conversionUnit>): string => unit.unit_id,
        ),
      ).size === value.units.length &&
      value.units.reduce(
        (total: number, unit: z.infer<typeof conversionUnit>): number =>
          total + new TextEncoder().encode(unit.content).byteLength,
        0,
      ) <=
        4 * 1024 * 1024,
    '변환 단위의 ID·전체 UTF-8 크기와 미독 범위/완전성 표시를 확인해 주세요.',
  );
const plannedOutput = z.strictObject({
  document,
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(1000),
  locations: analysisLocations.optional(),
  outputs: z
    .array(z.enum(['wiki', 'ontology']))
    .min(1)
    .max(2)
    .refine(
      (value: ('wiki' | 'ontology')[]): boolean =>
        new Set(value).size === value.length,
    ),
});
export const createAnalysisPlanInputSchema = z
  .strictObject({
    request_id: id,
    source_ref: analysisSourceRef.nullable().optional(),
    wiki_ref: analysisWikiRef.nullable().optional(),
    conversion_ref: z
      .strictObject({ conversion_id: id, conversion_revision: revision })
      .nullable()
      .optional(),
    locations: analysisLocations.optional(),
    outputs: z.array(plannedOutput).min(1).max(8),
    context_documents: z
      .array(
        z.strictObject({
          document,
          required: z.boolean(),
          reason: z.string().min(1).max(1000),
        }),
      )
      .max(7)
      .optional(),
  })
  .refine(
    (value: {
      source_ref?: unknown;
      wiki_ref?: unknown;
      conversion_ref?: unknown;
      outputs: z.infer<typeof plannedOutput>[];
    }): boolean =>
      (value.source_ref != null) !== (value.wiki_ref != null) &&
      !(value.wiki_ref != null && value.conversion_ref != null) &&
      new Set(
        value.outputs.map(
          (output: z.infer<typeof plannedOutput>): string => output.document,
        ),
      ).size === value.outputs.length,
    '등록 원본과 Wiki 중 한 출처와 중복 없는 산출 문서를 지정해 주세요.',
  );

// 업무별 명시 입력만 받습니다. profile·tenant·actor·주소·HTTP 메서드는 main이 정합니다.
export const workspaceRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('search'),
    input: z.strictObject({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('ontology'),
    input: documentInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('connections'),
    input: z.strictObject({ document, limit }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('context'),
    input: z.strictObject({ documents }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('conceptFind'),
    input: z.strictObject({
      text: z.string().min(1).max(200),
      ...conceptScope,
      include_history: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('conceptQuery'),
    input: z.strictObject({
      target: knowledgeValueSchema,
      ...conceptScope,
      correspondence_ids: z.array(text).max(8).nullable().optional(),
      expansion: z.enum(['none', 'direct_confirmed']).optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('impact'),
    input: z.strictObject({
      document,
      limit,
      baseline: z
        .strictObject({
          source_revision: revision,
          graph_revision: revision.nullable(),
          review_revision: revision.nullable(),
          history_revision: revision,
        })
        .nullable()
        .optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('reviewQueue'),
    input: z.strictObject({
      ...aggregate,
      states: z
        .array(z.enum(['unreviewed', 'defer', 'pending']))
        .min(1)
        .max(3)
        .optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('history'),
    input: z.strictObject({
      ...aggregate,
      job_ids: z.array(text).max(8).optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('questionContext'),
    input: questionContextInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('saveDocument'),
    input: z.strictObject({
      document,
      content,
      expected_revision: revision.nullable(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('documentVersions'),
    input: pageInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('documentVersion'),
    input: z.strictObject({ document, history_id: historyId }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('restoreDocument'),
    input: z.strictObject({
      document,
      history_id: historyId,
      expected_revision: revision,
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('review'),
    input: z.strictObject({
      ...claimBase,
      action: z.enum(['accept', 'edit', 'reject', 'defer']),
      replacement: knowledgeValueSchema.nullable().optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('reviewUndo'),
    input: undoInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('policy'),
    input: z.strictObject({
      ...claimBase,
      replacement: knowledgeValueSchema,
      entities: z.array(knowledgeValueSchema).max(500).nullable().optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('policyUndo'),
    input: undoInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('events'),
    input: pageInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('event'),
    input: z.strictObject({ document, event_id: id }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('conversations'),
    input: personalPage,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('conversation'),
    input: recordInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('createConversation'),
    input: z.strictObject(creation),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('appendTurn'),
    input: z
      .strictObject({
        record_id: id,
        request_id: id,
        expected_revision: revision,
        role: z.enum(['user', 'assistant']),
        content: z.string().max(65536),
        status: z.enum(['complete', 'failed']).optional(),
        context_request: questionContextInput.nullable().optional(),
        reply_to: id.nullable().optional(),
      })
      .refine(
        (value: {
          role: 'user' | 'assistant';
          context_request?: unknown;
          reply_to?: string | null;
          status?: 'complete' | 'failed';
          content: string;
        }): boolean =>
          value.role === 'user'
            ? value.context_request != null &&
              value.reply_to == null &&
              value.status !== 'failed' &&
              value.content.length > 0
            : value.reply_to != null &&
              value.context_request == null &&
              (value.content.length > 0 || value.status === 'failed'),
        '질문은 명시 맥락, 답변은 저장된 질문 참조가 필요합니다.',
      ),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('savedResults'),
    input: personalPage,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('savedResult'),
    input: recordInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('createSavedResult'),
    input: z
      .strictObject({
        ...creation,
        content: z.string().max(65536).nullable().optional(),
        context_request: questionContextInput.nullable().optional(),
        conversation_id: id.nullable().optional(),
        turn_id: id.nullable().optional(),
      })
      .refine(
        (value: {
          content?: string | null;
          context_request?: unknown;
          conversation_id?: string | null;
          turn_id?: string | null;
        }): boolean =>
          (value.content != null &&
            value.context_request != null &&
            value.conversation_id == null &&
            value.turn_id == null) ||
          (value.conversation_id != null &&
            value.turn_id != null &&
            value.content == null &&
            value.context_request == null),
        '직접 작성 결과와 저장된 답변 중 하나만 선택합니다.',
      ),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('comparisons'),
    input: personalPage,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('comparison'),
    input: recordInput,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('createComparison'),
    input: z.strictObject({
      ...creation,
      baseline_result_id: id,
      context_request: questionContextInput,
      mappings: z
        .array(
          z
            .strictObject({
              document,
              old_claim_id: revision.nullable().optional(),
              new_claim_id: revision.nullable().optional(),
              disposition: z.enum(['same', 'changed', 'missing', 'new']),
              reason: z.string().min(1).max(1000),
            })
            .refine(
              (value: {
                disposition: 'same' | 'changed' | 'missing' | 'new';
                old_claim_id?: string | null;
                new_claim_id?: string | null;
              }): boolean =>
                value.disposition === 'missing'
                  ? value.old_claim_id != null && value.new_claim_id == null
                  : value.disposition === 'new'
                    ? value.old_claim_id == null && value.new_claim_id != null
                    : value.old_claim_id != null && value.new_claim_id != null,
              '대응 분류에 맞는 이전·새 주장 ID가 필요합니다.',
            ),
        )
        .max(100)
        .optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('completeComparison'),
    input: z.strictObject({
      record_id: id,
      request_id: id,
      expected_revision: revision,
      outcome: z.enum(['reviewed', 'deferred']),
      reason: z.string().min(1).max(1000),
      reviewed_claims: z.array(claimSelection).max(100).optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('personalReceipt'),
    input: z.strictObject({
      kind: z.enum(['conversations', 'saved-results', 'comparisons']),
      request_id: id,
      record_id: id.nullable().optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondenceFind'),
    input: z.strictObject({
      documents,
      text: z.string().max(2000).nullable().optional(),
      ...correspondenceScope,
      limit,
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondenceDraft'),
    input: z.strictObject({ draft: knowledgeValueSchema }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondencePropose'),
    input: z.strictObject({
      draft: knowledgeValueSchema,
      correspondence_id: id,
      ...changeReason,
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondenceQuery'),
    input: z.strictObject({ correspondence_id: id, ...correspondenceScope }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondencePrepare'),
    input: z.strictObject({
      correspondence_id: id,
      operation: z.enum(['review', 'review_undo', 'policy', 'policy_undo']),
      change: knowledgeValueSchema,
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondenceReview'),
    input: z.strictObject({
      correspondence_id: id,
      ...changeReason,
      action: z.enum(['accept', 'reject', 'defer', 'edit']),
      replacement: knowledgeValueSchema.nullable().optional(),
      decision: z.enum(['accepted', 'deferred']).nullable().optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondenceReviewUndo'),
    input: correspondenceUndo,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondencePolicy'),
    input: z.strictObject({
      correspondence_id: id,
      ...changeReason,
      replacement: knowledgeValueSchema,
      judgment_id: id.nullable().optional(),
      supersedes_event_id: id.nullable().optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('correspondencePolicyUndo'),
    input: correspondenceUndo,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('extraction'),
    input: z.strictObject({ extraction_id: id, job_id: id }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('extractionContent'),
    input: z.strictObject({
      extraction_id: id,
      job_id: id,
      extraction_revision: revision,
      offset: z
        .number()
        .int()
        .min(0)
        .max(4 * 1024 * 1024)
        .optional(),
      limit: z.number().int().min(1).max(65536).optional(),
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('artifactReceipt'),
    input: z.strictObject({ job_id: id, request_id: id }),
  }),
  z.strictObject({
    connectionId,
    expectedScope: workspaceScopeSchema,
    operation: z.literal('createConversion'),
    input: createConversionInputSchema,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('conversion'),
    input: z.strictObject({ conversion_id: id }),
  }),
  z.strictObject({
    connectionId,
    expectedScope: workspaceScopeSchema,
    operation: z.literal('createAnalysisPlan'),
    input: createAnalysisPlanInputSchema,
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('analysisPlan'),
    input: z.strictObject({ plan_id: id }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('validateAnalysisPlan'),
    input: z.strictObject({ plan_id: id, expected_plan_revision: revision }),
  }),
  z.strictObject({
    connectionId,
    expectedScope: workspaceScopeSchema,
    operation: z.literal('handoffAnalysisPlan'),
    input: z.strictObject({
      plan_id: id,
      request_id: id,
      expected_plan_revision: revision,
    }),
  }),
  z.strictObject({
    connectionId,
    expectedScope,
    operation: z.literal('analysisPlanReceipt'),
    input: z.strictObject({ plan_id: id, request_id: id }),
  }),
]);
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
export type WorkspaceOperation = WorkspaceRequest['operation'];
const operation = z.enum(
  workspaceRequestSchema.options.map(
    (
      entry: (typeof workspaceRequestSchema.options)[number],
    ): WorkspaceOperation => entry.shape.operation.value,
  ),
);
const response = z.object({
  connectionId,
  operation,
  data: knowledgeValueSchema,
  access: documentListPageSchema.shape.access,
  traceId: id,
});
const error = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,128}$/),
  message: text,
  status: z.number().int().min(100).max(599).optional(),
  traceId: id.optional(),
  retry: z.enum(['none', 'read_again', 'same_basis', 'reconcile']).optional(),
  cleanupWarningCount: z.number().int().min(0).optional(),
  recovery: z
    .discriminatedUnion('operation', [
      z.strictObject({
        operation: z.literal('conversion'),
        input: z.strictObject({ conversion_id: id }),
      }),
      z.strictObject({
        operation: z.literal('analysisPlan'),
        input: z.strictObject({ plan_id: id }),
      }),
      z.strictObject({
        operation: z.literal('analysisPlanReceipt'),
        input: z.strictObject({ plan_id: id, request_id: id }),
      }),
    ])
    .optional(),
});
export type WorkspaceRecovery = NonNullable<z.infer<typeof error>['recovery']>;
const result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: response }),
  z.object({ ok: z.literal(false), error }),
]);
export type WorkspaceResponse = z.infer<typeof response>;
export type WorkspaceResult = z.infer<typeof result>;
export type WorkspaceBridge = {
  execute: (request: WorkspaceRequest) => Promise<WorkspaceResult>;
};

/** 요청은 명시한 업무와 필드만 허용하며 임의 경로·주체·관점 입력을 거부합니다. */
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  return workspaceRequestSchema.parse(value);
}

/** 응답의 전체 업무 JSON과 조회 범위를 공개 계약으로 다시 검사합니다. */
export function parseWorkspaceResult(value: unknown): WorkspaceResult {
  return result.parse(value);
}
