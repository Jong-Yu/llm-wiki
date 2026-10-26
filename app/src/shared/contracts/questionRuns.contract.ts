import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';
import { knowledgeValueSchema } from './knowledge.contract';
import type { KnowledgeValue } from './knowledge.contract';

export const QUESTION_RUN_CHANNELS = {
  create: 'question-runs:create',
  creationReceipt: 'question-runs:creation-receipt',
  list: 'question-runs:list',
  read: 'question-runs:read',
  start: 'question-runs:start',
  cancel: 'question-runs:cancel',
} as const;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const questionSessionSchema = z.strictObject({
  connectionId: z.string().min(1).max(4096),
  expectedScope: workspaceScopeSchema,
});
export const questionReadSchema = questionSessionSchema.extend({
  questionRunId: id,
});
export const questionCreateSchema = questionSessionSchema.extend({
  requestId: id,
  conversationId: id,
  questionTurnId: id,
  conversationRevision: revision,
});
export const questionCreationReceiptSchema = questionSessionSchema.extend({
  requestId: id,
});
export const questionListSchema = questionSessionSchema.extend({
  cursor: z.string().max(16384).nullable().default(null),
});
export const questionStartSchema = questionReadSchema.extend({
  expectedStateRevision: revision,
  reclaim: z.boolean().default(false),
});
export const questionCancelSchema = questionReadSchema.extend({
  requestId: id,
  expectedStateRevision: revision,
});
export type QuestionSession = z.infer<typeof questionSessionSchema>;
export type QuestionReadRequest = z.infer<typeof questionReadSchema>;
export type QuestionCreateRequest = z.infer<typeof questionCreateSchema>;
export type QuestionCreationReceiptRequest = z.infer<
  typeof questionCreationReceiptSchema
>;
export type QuestionListRequest = z.infer<typeof questionListSchema>;
export type QuestionStartRequest = z.infer<typeof questionStartSchema>;
export type QuestionCancelRequest = z.infer<typeof questionCancelSchema>;
export type QuestionError = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
};
export type QuestionOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: QuestionError };

export const questionReceiptSchema = z.object({
  record_id: id,
  request_id: id,
  state: z.enum(['complete', 'pending_reconcile', 'rejected']),
  saved: z.boolean().nullable(),
  receipt: z
    .object({
      conversation_id: id,
      conversation_revision: revision,
      answer_turn_id: id,
      question_run_id: id,
      basis_snapshot_revision: revision,
      human_approval: z.literal(false),
      semantic_validation: z.literal('not_run'),
      citation_validation: z.string(),
      execution: knowledgeValueSchema,
    })
    .nullable(),
  cleanup_failures: z.array(z.unknown()),
});
export type QuestionReceipt = z.infer<typeof questionReceiptSchema>;
export type QuestionEvidence = {
  kind: 'document' | 'source';
  label: string;
  sourceRevision: string;
  graphRevision: string | null;
  stateRevision: string | null;
  sourceId: string | null;
  sourceVersion: string | null;
};
export type QuestionLocal = {
  status: 'idle' | 'running' | 'stopping' | 'exited' | 'failed';
  phase: string;
  preview: string;
  requestId: string | null;
  errorCode: string | null;
  cleanupWarning: boolean;
};
export type QuestionAnswer = {
  turnId: string;
  content: string;
  citations: KnowledgeValue[];
};
export type QuestionDetail = {
  id: string;
  conversationId: string;
  questionTurnId: string;
  question: string;
  profileId: string;
  basisRevision: string;
  evidence: QuestionEvidence[];
  stateRevision: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress: string;
  leaseStatus: 'none' | 'active' | 'expired';
  receipts: QuestionReceipt[];
  answers: QuestionAnswer[];
  answerReadError: string | null;
  local: QuestionLocal;
};
export type QuestionDetailResult = QuestionOutcome<QuestionDetail>;
export type QuestionPage = {
  items: { id: string; title: string; created_at: string }[];
  nextCursor: string | null;
  incomplete: boolean;
};
export type QuestionPageResult = QuestionOutcome<QuestionPage>;
export type QuestionRunsBridge = {
  create: (request: QuestionCreateRequest) => Promise<QuestionDetailResult>;
  creationReceipt: (
    request: QuestionCreationReceiptRequest,
  ) => Promise<QuestionDetailResult>;
  list: (request: QuestionListRequest) => Promise<QuestionPageResult>;
  read: (request: QuestionReadRequest) => Promise<QuestionDetailResult>;
  start: (request: QuestionStartRequest) => Promise<QuestionDetailResult>;
  cancel: (request: QuestionCancelRequest) => Promise<QuestionDetailResult>;
};

const questionDetailSchema = z.object({
  id,
  conversationId: id,
  questionTurnId: id,
  question: z.string(),
  profileId: z.string(),
  basisRevision: revision,
  evidence: z.array(
    z.object({
      kind: z.enum(['document', 'source']),
      label: z.string(),
      sourceRevision: revision,
      graphRevision: revision.nullable(),
      stateRevision: revision.nullable(),
      sourceId: id.nullable(),
      sourceVersion: id.nullable(),
    }),
  ),
  stateRevision: revision,
  status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
  progress: z.string(),
  leaseStatus: z.enum(['none', 'active', 'expired']),
  receipts: z.array(questionReceiptSchema),
  answers: z.array(
    z.object({
      turnId: id,
      content: z.string(),
      citations: z.array(knowledgeValueSchema),
    }),
  ),
  answerReadError: z.string().nullable(),
  local: z.object({
    status: z.enum(['idle', 'running', 'stopping', 'exited', 'failed']),
    phase: z.string(),
    preview: z.string(),
    requestId: id.nullable(),
    errorCode: z.string().nullable(),
    cleanupWarning: z.boolean(),
  }),
});
const questionFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().optional(),
    traceId: z.string().optional(),
  }),
});
/** main 응답도 preload에서 검사해 알 수 없는 IPC 객체를 화면으로 넘기지 않습니다. */
export function parseQuestionDetailResult(
  value: unknown,
): QuestionDetailResult {
  return z
    .union([
      z.object({ ok: z.literal(true), data: questionDetailSchema }),
      questionFailureSchema,
    ])
    .parse(value);
}
/** 부분 조회·다음 커서가 있는 질문 목록 응답을 검사합니다. */
export function parseQuestionPageResult(value: unknown): QuestionPageResult {
  return z
    .union([
      z.object({
        ok: z.literal(true),
        data: z.object({
          items: z.array(
            z.object({ id, title: z.string(), created_at: z.string() }),
          ),
          nextCursor: z.string().nullable(),
          incomplete: z.boolean(),
        }),
      }),
      questionFailureSchema,
    ])
    .parse(value);
}
