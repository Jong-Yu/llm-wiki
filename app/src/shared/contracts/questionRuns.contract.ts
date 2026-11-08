import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';
import { knowledgeValueSchema } from './knowledge.contract';
import type { KnowledgeValue } from './knowledge.contract';
import { webEvidenceInputSchema } from './webEvidence.contract';

export const QUESTION_RUN_CHANNELS = {
  create: 'question-runs:create',
  creationReceipt: 'question-runs:creation-receipt',
  list: 'question-runs:list',
  read: 'question-runs:read',
  start: 'question-runs:start',
  cancel: 'question-runs:cancel',
  resumable: 'question-runs:resumable',
  searchTerms: 'question-runs:search-terms',
  webSearch: 'question-runs:web-search',
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
/** 이어 갈 AI 세션 확인 입력입니다. 경로가 되는 값은 정규식·열거형으로 제한합니다. */
export const questionResumableSchema = z.strictObject({
  conversationId: id,
  provider: z.enum(['codex', 'claude']),
  precedingTurns: z.number().int().min(0).max(100000),
});
export type QuestionResumableRequest = z.infer<typeof questionResumableSchema>;
export type QuestionResumableResult = { resumable: boolean };
/** main 응답도 preload에서 검사합니다. */
export function parseQuestionResumableResult(
  value: unknown,
): QuestionResumableResult {
  return z.object({ resumable: z.boolean() }).parse(value);
}
/** 질문 문장만 선택한 AI에 보내 위키 검색어로 풀어 오게 하는 입력입니다. 위키 자료는 보내지 않습니다. */
export const questionSearchTermsSchema = questionSessionSchema.extend({
  question: z.string().trim().min(1).max(2000),
});
export type QuestionSearchTermsRequest = z.infer<
  typeof questionSearchTermsSchema
>;
/** 실패·취소·시간 초과는 오류가 아니라 빈 목록으로, 호출자는 기존 검색만으로 계속합니다. */
export type QuestionSearchTermsResult = { terms: string[] };
/** 명시한 공개 검색어만 웹 조사에 전달합니다. 위키·첨부·대화는 받지 않습니다. */
export const questionWebSearchSchema = questionSessionSchema.extend({
  query: z.string().trim().min(1).max(200),
});
export type QuestionWebSearchRequest = z.infer<typeof questionWebSearchSchema>;
const questionWebSearchResultSchema = z.strictObject({
  web: webEvidenceInputSchema,
});
export type QuestionWebSearchResult = z.infer<
  typeof questionWebSearchResultSchema
>;
/** 읽은 원문과 출처의 한도 및 주소를 preload에서도 검사합니다. */
export function parseQuestionWebSearchResult(
  value: unknown,
): QuestionWebSearchResult {
  return questionWebSearchResultSchema.parse(value);
}
export function parseQuestionSearchTermsResult(
  value: unknown,
): QuestionSearchTermsResult {
  return z
    .object({ terms: z.array(z.string().min(2).max(60)).max(12) })
    .parse(value);
}
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
  /** AI 세션 이어가기가 실패해 전체 대화로 다시 시작했는지 나타냅니다. */
  resumeFailed?: boolean;
  /** 새 세션에 앞선 대화를 전달하기 시작한 실행에서만 참이다. */
  historyReplayed?: boolean;
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
  resumable: (
    request: QuestionResumableRequest,
  ) => Promise<QuestionResumableResult>;
  searchTerms: (
    request: QuestionSearchTermsRequest,
  ) => Promise<QuestionSearchTermsResult>;
  webSearch: (
    request: QuestionWebSearchRequest,
  ) => Promise<QuestionWebSearchResult>;
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
    resumeFailed: z.boolean().optional(),
    historyReplayed: z.boolean().optional(),
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
