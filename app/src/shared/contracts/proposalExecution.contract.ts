import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';
import { knowledgeValueSchema } from './knowledge.contract';

export const PROPOSAL_EXECUTION_CHANNELS = {
  start: 'proposal-execution:start',
  read: 'proposal-execution:read',
  cancel: 'proposal-execution:cancel',
} as const;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const scope = {
  connectionId: z.string().min(1),
  expectedScope: workspaceScopeSchema,
  proposalId: id,
};
export const proposalExecutionStartSchema = z.strictObject({
  ...scope,
  requestId: id,
  expectedStateRevision: revision,
  candidateRevision: revision.nullable(),
  semanticCheck: z.boolean(),
});
export const proposalExecutionReadSchema = z.strictObject({
  ...scope,
  executionId: id,
});
export const proposalExecutionCancelSchema = proposalExecutionReadSchema;
export type ProposalExecutionStart = z.infer<
  typeof proposalExecutionStartSchema
>;
export type ProposalExecutionRead = z.infer<typeof proposalExecutionReadSchema>;
export type ProposalExecutionCancel = z.infer<
  typeof proposalExecutionCancelSchema
>;
export const proposalExecutionLocalSchema = z.object({
  status: z.enum(['idle', 'running', 'stopping', 'exited', 'failed']),
  phase: z.string().max(128),
  errorCode: z.string().max(128).nullable(),
  requestId: id.nullable(),
  preview: z.string().max(65536),
  previewTruncated: z.boolean(),
  cleanupWarning: z.boolean(),
});
export type ProposalExecutionLocal = z.infer<
  typeof proposalExecutionLocalSchema
>;
export const proposalExecutionDetailSchema = z.object({
  proposalId: id,
  executionId: id,
  local: proposalExecutionLocalSchema,
  server: knowledgeValueSchema.nullable(),
});
export type ProposalExecutionDetail = z.infer<
  typeof proposalExecutionDetailSchema
>;
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: proposalExecutionDetailSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      executionId: id.optional(),
      status: z.number().optional(),
    }),
  }),
]);
export type ProposalExecutionResult = z.infer<typeof resultSchema>;
export type ProposalExecutionBridge = {
  start: (request: ProposalExecutionStart) => Promise<ProposalExecutionResult>;
  read: (request: ProposalExecutionRead) => Promise<ProposalExecutionResult>;
  cancel: (
    request: ProposalExecutionCancel,
  ) => Promise<ProposalExecutionResult>;
};
/** IPC 응답을 검증하며 실행 성공을 후보 저장이나 사람 승인으로 변환하지 않습니다. */
export function parseProposalExecutionResult(
  value: unknown,
): ProposalExecutionResult {
  return resultSchema.parse(value);
}
