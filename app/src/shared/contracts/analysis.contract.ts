import { z } from 'zod';
import { isDocumentPath } from './documents.contract';
import { knowledgeValueSchema } from './knowledge.contract';

// Electron 내부에서만 쓰는 제한된 동작입니다. 임의 명령·파일 경로는 받지 않습니다.
export const ANALYSIS_CHANNELS = {
  list: 'analysis:list',
  start: 'analysis:start',
  read: 'analysis:read',
  cancel: 'analysis:cancel',
  inspectExecution: 'analysis:inspect-execution',
  execute: 'analysis:execute',
  stopLocal: 'analysis:stop-local',
} as const;
const text = z.string().min(1).max(4096);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const output = z.enum(['wiki', 'ontology']);
const stage = z.enum(['prepare_wiki', 'extract_ontology']);
const saved = z.boolean().nullable();
const resultState = z.enum([
  'draft',
  'complete',
  'pending_reconcile',
  'rejected',
  'storage_busy',
]);
const error = z.object({
  code: text,
  message: text,
  status: z.number().optional(),
  traceId: text.optional(),
});
const actorSchema = z.object({
  user_id: text,
  tenant: text,
  profile_id: text,
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: revision,
});
export const analysisListRequestSchema = z.strictObject({
  connectionId: text,
  sourceId: id.nullable().default(null),
  cursor: z.string().min(1).max(16384).nullable().default(null),
});
export const analysisReadRequestSchema = z.strictObject({
  connectionId: text,
  jobId: id,
});
export const analysisCancelRequestSchema = analysisReadRequestSchema.extend({
  expectedJobRevision: revision,
});
export const analysisExecuteRequestSchema = analysisReadRequestSchema.extend({
  expectedJobRevision: revision,
  mode: z.enum(['start', 'resume']),
});
export type AnalysisExecutionScope = {
  connectionId: string;
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
};
export const analysisStartRequestSchema = z.strictObject({
  connectionId: text,
  sourceId: id,
  sourceVersion: id,
  sourceSha256: revision,
  registrationRevision: revision,
  targetDocument: text.refine(isDocumentPath),
  outputs: z
    .array(output)
    .min(1)
    .max(2)
    .refine(
      (values: string[]): boolean => new Set(values).size === values.length,
    ),
});
export const analysisJobSchema = z.object({
  actor: actorSchema,
  job_id: id,
  tenant: text,
  user_id: text,
  request_id: id,
  created_at: text,
  source_ref: z.object({
    source_id: id,
    source_version: id,
    source_sha256: revision,
    size_bytes: z.number().int().nonnegative(),
    registration_revision: revision,
  }),
  targets: z.array(
    z.object({
      document: text,
      source_revision: revision.nullable(),
      state_revision: revision.nullable(),
    }),
  ),
  outputs: z.array(output),
  state: z.enum(['awaiting_cli', 'claimed', 'cancelled']),
  run_id: id.nullable(),
  reported_status: z
    .enum(['input_ready', 'analyzing', 'blocked', 'failed', 'stopped'])
    .nullable(),
  job_revision: revision,
  events: z.array(knowledgeValueSchema).default([]),
  active_input_ref: z
    .object({
      bundle_id: id,
      bundle_revision: revision,
      stage: z.enum(['read_source', 'prepare_wiki', 'extract_ontology']),
    })
    .nullable()
    .default(null),
  analysis_basis_ref: z
    .object({
      revision,
      ruleset_ref: z.record(z.string(), z.json()),
      profile: z.object({
        profile_id: text,
        domain: z.string().nullable(),
        viewpoint: z.string().nullable(),
      }),
      context_documents: z.array(
        z.object({ document: text, required: z.boolean(), reason: z.string() }),
      ),
    })
    .nullable()
    .default(null),
  legacy_rebase_required: z.boolean().default(false),
  lease_status: z.enum(['none', 'active', 'expired']),
  lease_expires_at: text.nullable(),
  basis_status: z.enum(['current', 'changed', 'missing']),
  blockers: z.array(text),
  input_readiness: text,
  result_summary: z.object({
    status: z.enum([
      'draft',
      'not_started',
      'partial',
      'complete',
      'pending_reconcile',
      'rejected',
    ]),
    saved_count: z.number().int().nonnegative(),
    required_count: z.number().int().nonnegative(),
    results: z.array(
      z.object({
        request_id: id,
        stage,
        document: text,
        run_id: id,
        state: resultState,
        saved,
        basis_current: z.boolean().nullable().optional(),
        current_scope: z.boolean().optional(),
        current_run: z.boolean().optional(),
      }),
    ),
  }),
});
const executionSchema = z
  .object({
    origin: z.literal('client_reported'),
    provider: text,
    cli_version: text,
    requested_model: z.string().nullable(),
    reported_model: z.string().nullable(),
    prompt_sha256: revision,
    schema_sha256: revision,
    output_sha256: revision,
  })
  .catchall(z.json());
const diagnosticText = z.string().min(1).max(2000);
const diagnosticRange = z
  .strictObject({
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
  })
  .refine(
    (value: { start_line: number; end_line: number }): boolean =>
      value.start_line <= value.end_line,
  );
const diagnosticQuote = z
  .strictObject({
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
    quote: z.string().min(1).max(4000),
  })
  .refine(
    (value: { start_line: number; end_line: number }): boolean =>
      value.start_line <= value.end_line,
  );
const diagnosticTarget = z.strictObject({
  collection: z.enum([
    'entities',
    'relations',
    'attributes',
    'relation_candidates',
  ]),
  index: z.number().int().nonnegative(),
});
const diagnosticFinding = z.strictObject({
  rule_id: z.string().regex(/^R-S(0[1-9]|10)$/),
  verdict: z.enum([
    'supported',
    'contradicted',
    'unsupported',
    'condition_loss',
    'ambiguous',
    'omission',
    'schema_limit',
    'not_run',
    'undetermined',
  ]),
  source: diagnosticQuote.nullable(),
  target: diagnosticTarget.nullable(),
  reason: diagnosticText,
  recommendation: diagnosticText.nullable(),
  question: diagnosticText.nullable(),
});
/** 발행된 진단 형식을 확인하며 의견을 현재 claim 상태나 실제 사람 승인으로 변환하지 않습니다. */
const diagnosticReportV1 = z.strictObject({
  schema_version: z.literal(1),
  reviewer_kind: z.enum([
    'ai_self_check',
    'separate_ai',
    'human_reported',
    'not_reported',
  ]),
  warnings: z.array(diagnosticText).max(100),
  omissions: z.array(diagnosticText).max(100),
  unread_ranges: z.array(diagnosticText).max(100),
  reviewed_ranges: z.array(diagnosticRange).max(100),
  findings: z.array(diagnosticFinding).max(100),
});
const ruleStatus = z.enum([
  'pass',
  'fail',
  'not_run',
  'not_applicable',
  'error',
]);
export const analysisSemanticRuleSchema = z.strictObject({
  rule_id: z.string().regex(/^R-S(0[1-9]|10)$/),
  status: ruleStatus,
  reason: diagnosticText,
  finding_indices: z.array(z.number().int().nonnegative()).max(100),
});
const checkExecutionSchema = z.strictObject({
  provider: z.enum(['codex', 'claude']),
  cli_version: z.string().min(1).max(100),
  prompt_sha256: revision,
  schema_sha256: revision,
  output_sha256: revision,
});
const semanticCheckSchema = z.strictObject({
  check_id: id,
  input: z.strictObject({
    job_id: id,
    run_id: id,
    bundle_id: id,
    bundle_revision: revision,
    document: text,
    source_revision: revision,
    submission_sha256: revision,
    schema_version: z.union([
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    ruleset_ref: z.strictObject({
      ruleset_id: text,
      ruleset_version: text,
      ruleset_revision: revision,
    }),
  }),
  source_audit_execution: checkExecutionSchema.nullable(),
  assessment_execution: checkExecutionSchema.nullable(),
  source_audit_sha256: revision.nullable(),
  source_audit: z.string().min(1).max(16000).nullable(),
});
/** v1의 의견을 규칙별 통과로 올리지 않고 새 보고의 다섯 판정 상태를 보존합니다. */
export const analysisDiagnosticReportSchema = z.discriminatedUnion(
  'schema_version',
  [
    diagnosticReportV1,
    diagnosticReportV1.extend({
      schema_version: z.literal(2),
      rule_results: z.array(analysisSemanticRuleSchema).length(10),
      semantic_check: semanticCheckSchema.nullable(),
    }),
  ],
);
const semanticSummarySchema = z.strictObject({
  status: z.enum(['client_reported', 'not_run']),
  human_approval: z.literal(false),
  reviewer_kind: diagnosticReportV1.shape.reviewer_kind,
  rule_results: z.array(analysisSemanticRuleSchema).length(10),
});
export const analysisAutomaticRuleSchema = z
  .object({
    rule_id: z.string().regex(/^R-A(0[1-9]|10)$/),
    status: ruleStatus,
    checker: text,
    reason: text,
  })
  .catchall(z.json());
export type AnalysisSemanticRule = z.infer<typeof analysisSemanticRuleSchema>;
export type AnalysisAutomaticRule = z.infer<typeof analysisAutomaticRuleSchema>;
// 규약·추출물·증거 출처의 세대별 한정 필드를 자르지 않고 전체 고정 기준을 보존합니다.
const diagnosticBasis = z
  .object({
    job_id: id,
    run_id: id,
    bundle_id: id,
    bundle_revision: revision,
    document: text.refine(isDocumentPath),
    stage,
    source_revision: revision.nullable(),
    submission_hash: revision,
  })
  .catchall(z.json());
const diagnosticObservation = {
  report_id: id,
  report_hash: revision,
  origin: z.literal('client_reported'),
  human_approval: z.literal(false),
  basis: diagnosticBasis,
  semantic: semanticSummarySchema.optional(),
};
// 검사를 통과하지 못한 제출도 서버에 보존되므로 원형을 읽되 구조화된 사실처럼 취급하지 않습니다.
export const analysisDiagnosticsSchema = z.discriminatedUnion('validation', [
  z.strictObject({
    ...diagnosticObservation,
    validation: z.literal('structure_and_source_checked'),
    report: analysisDiagnosticReportSchema,
  }),
  z.strictObject({
    ...diagnosticObservation,
    validation: z.literal('not_validated'),
    report: z.json(),
  }),
]);
export const analysisReceiptSchema = z.object({
  request_id: id,
  state: resultState,
  saved,
  receipt: z
    .object({
      actor: actorSchema,
      document: text,
      stage,
      source_revision: revision,
      graph_revision: revision.nullable(),
      state_revision: revision.nullable(),
      history_revision: revision.nullable().optional(),
      bundle_id: id,
      bundle_revision: revision,
      review_status: z.literal('unreviewed'),
      execution: executionSchema.nullable().optional(),
      analysis_basis_revision: revision.nullable().optional(),
    })
    .catchall(z.json())
    .nullable(),
  validation_report: z
    .object({
      automatic: text,
      error_code: z.string().nullable().optional(),
      semantic: z.object({ status: text, human_approval: z.literal(false) }),
      assurance: text,
      rule_results: z.array(analysisAutomaticRuleSchema).optional(),
    })
    .catchall(z.json())
    .nullable(),
  current_output: z
    .object({
      status: z.enum(['current', 'changed', 'unavailable']),
      state_changed: z.boolean().nullable().optional(),
      source_revision: revision.nullable().optional(),
      graph_revision: revision.nullable().optional(),
      state_revision: revision.nullable().optional(),
    })
    .catchall(z.json())
    .nullable(),
  cleanup_failures: z.array(z.unknown()),
  diagnostics: analysisDiagnosticsSchema.nullable().default(null),
});
export const analysisLocalSchema = z.object({
  status: z.enum(['idle', 'running', 'completed', 'failed', 'stopped']),
  message: z.string().max(4096),
});
export const analysisDetailSchema = z.object({
  job: analysisJobSchema,
  local: analysisLocalSchema,
  receipts: z.array(analysisReceiptSchema),
  receiptErrors: z.array(z.object({ requestId: id, message: text })),
});
export const analysisPageSchema = z.object({
  items: z.array(analysisJobSchema),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skippedCount: z.number().int().nonnegative(),
  requiresRefresh: z.boolean(),
});
const detailResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: analysisDetailSchema }),
  z.object({ ok: z.literal(false), error }),
]);
export const analysisExecutionInspectionSchema = z.object({
  detail: analysisDetailSchema,
  mode: z.enum(['start', 'resume']).nullable(),
  blockers: z.array(text),
  checkedAt: text,
});
const executionInspectionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: analysisExecutionInspectionSchema }),
  z.object({ ok: z.literal(false), error }),
]);
export type AnalysisExecuteRequest = z.infer<
  typeof analysisExecuteRequestSchema
>;
export type AnalysisExecutionInspection = z.infer<
  typeof analysisExecutionInspectionSchema
>;
export type AnalysisExecutionInspectionResult = z.infer<
  typeof executionInspectionResultSchema
>;
const pageResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: analysisPageSchema }),
  z.object({ ok: z.literal(false), error }),
]);
export type AnalysisListRequest = z.infer<typeof analysisListRequestSchema>;
export type AnalysisStartRequest = z.infer<typeof analysisStartRequestSchema>;
export type AnalysisReadRequest = z.infer<typeof analysisReadRequestSchema>;
export type AnalysisCancelRequest = z.infer<typeof analysisCancelRequestSchema>;
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export type AnalysisReceipt = z.infer<typeof analysisReceiptSchema>;
export type AnalysisDiagnostics = z.infer<typeof analysisDiagnosticsSchema>;
export type AnalysisDiagnosticReport = z.infer<
  typeof analysisDiagnosticReportSchema
>;
export type AnalysisDiagnosticFinding = z.infer<typeof diagnosticFinding>;
export type AnalysisLocal = z.infer<typeof analysisLocalSchema>;
export type AnalysisDetail = z.infer<typeof analysisDetailSchema>;
export type AnalysisPage = z.infer<typeof analysisPageSchema>;
export type AnalysisDetailResult = z.infer<typeof detailResultSchema>;
export type AnalysisPageResult = z.infer<typeof pageResultSchema>;
export type AnalysisBridge = {
  list: (request: AnalysisListRequest) => Promise<AnalysisPageResult>;
  start: (request: AnalysisStartRequest) => Promise<AnalysisDetailResult>;
  read: (request: AnalysisReadRequest) => Promise<AnalysisDetailResult>;
  cancel: (request: AnalysisCancelRequest) => Promise<AnalysisDetailResult>;
  inspectExecution: (
    request: AnalysisReadRequest,
  ) => Promise<AnalysisExecutionInspectionResult>;
  execute: (request: AnalysisExecuteRequest) => Promise<AnalysisDetailResult>;
  stopLocal: (request: AnalysisReadRequest) => Promise<AnalysisDetailResult>;
};
/** preloadでも同じ検査を使い、mainから公開する値を固定します。 */
export function parseAnalysisDetailResult(
  value: unknown,
): AnalysisDetailResult {
  return detailResultSchema.parse(value);
}
/** ページが部分取得なら、その情報も消さず画面へ渡します。 */
export function parseAnalysisPageResult(value: unknown): AnalysisPageResult {
  return pageResultSchema.parse(value);
}

/** 실행 준비 확인도 조회 결과이며 모델 실행이나 저장 성공을 뜻하지 않습니다. */
export function parseAnalysisExecutionInspectionResult(
  value: unknown,
): AnalysisExecutionInspectionResult {
  return executionInspectionResultSchema.parse(value);
}
