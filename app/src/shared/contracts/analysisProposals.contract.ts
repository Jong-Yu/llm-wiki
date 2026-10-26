import { z } from 'zod';
import { isDocumentPath } from './documents.contract';
import { knowledgeValueSchema } from './knowledge.contract';
import { workspaceScopeSchema } from './workspace.contract';

export const ANALYSIS_PROPOSALS_CHANNELS = {
  execute: 'analysis-proposals:execute',
} as const;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const document = z.string().min(1).max(4096).refine(isDocumentPath);
const reason = z.string().trim().min(1).max(1000);
const base = {
  connectionId: z.string().min(1),
  expectedScope: workspaceScopeSchema,
};
const change = {
  proposal_id: id,
  request_id: id,
  expected_state_revision: revision,
};
const candidate = { ...change, candidate_revision: revision };
export const resolutionBindingSchema = z.strictObject({
  decision_id: id,
  new_claim_id: revision,
  reason,
});
export const proposalContextSchema = z.strictObject({
  document,
  required: z.boolean(),
  reason,
});
export const analysisProposalRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...base,
    operation: z.literal('execution-create'),
    input: z.strictObject({
      ...change,
      candidate_revision: revision.nullable(),
      reason,
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('execution-read'),
    input: z.strictObject({ proposal_id: id, execution_id: id }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('execution-cancel'),
    input: z.strictObject({
      proposal_id: id,
      job_id: id,
      expected_job_revision: revision,
      reason,
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('prepare'),
    input: z.strictObject({
      request_id: id,
      document,
      expected_source_revision: revision,
      expected_state_revision: revision,
      context_documents: z.array(proposalContextSchema).max(7),
      submission: knowledgeValueSchema.nullable().optional(),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('read'),
    input: z.strictObject({ proposal_id: id }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('submit'),
    input: z.strictObject({
      ...change,
      submission: knowledgeValueSchema,
      resolves_decision_ids: z.array(id).max(100),
      resolution_bindings: z.array(resolutionBindingSchema).max(100),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('validate'),
    input: z.strictObject({ proposal_id: id }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('apply'),
    input: z.strictObject(candidate),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('receipt'),
    input: z.strictObject({ proposal_id: id, request_id: id }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('decide'),
    input: z.strictObject({
      ...candidate,
      old_claim_id: revision,
      action: z.enum(['exclude', 'keep', 'reextract']),
      reason,
      checked_whole: z.boolean(),
      evidence: z.string().max(65536),
      replacement: knowledgeValueSchema.nullable(),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('complete'),
    input: z.strictObject({
      ...change,
      expected_review_state_revision: revision,
      reviewed_claim_ids: z.array(revision).max(100),
      reason,
    }),
  }),
]);
export type AnalysisProposalRequest = z.infer<
  typeof analysisProposalRequestSchema
>;
export type ProposalOperation = AnalysisProposalRequest['operation'];
export type ProposalRecovery = {
  proposalId: string;
  requestId: string;
  operation: ProposalOperation;
};
export type AnalysisProposalResult =
  | { ok: true; data: z.infer<typeof knowledgeValueSchema>; traceId: string }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
        retry?: string;
        traceId?: string;
        cleanupWarningCount?: number;
        recovery?: ProposalRecovery;
      };
    };
export type AnalysisProposalsBridge = {
  execute: (
    request: AnalysisProposalRequest,
  ) => Promise<AnalysisProposalResult>;
};

const proposalResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: knowledgeValueSchema,
    traceId: z.string().regex(/^[a-f0-9]{32}$/),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().regex(/^[a-z0-9_]{1,128}$/),
      message: z.string(),
      status: z.number().int().min(100).max(599).optional(),
      retry: z.string().optional(),
      traceId: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
      cleanupWarningCount: z.number().int().nonnegative().optional(),
      recovery: z
        .object({
          proposalId: id,
          requestId: id,
          operation: z.enum([
            'prepare',
            'read',
            'submit',
            'validate',
            'apply',
            'receipt',
            'decide',
            'complete',
            'execution-create',
            'execution-read',
            'execution-cancel',
          ]),
        })
        .optional(),
    }),
  }),
]);
/** preload가 알 수 없는 IPC 응답을 검증한 뒤 제한된 계약만 renderer에 노출합니다. */
export function parseAnalysisProposalResult(
  value: unknown,
): AnalysisProposalResult {
  return proposalResultSchema.parse(value);
}
