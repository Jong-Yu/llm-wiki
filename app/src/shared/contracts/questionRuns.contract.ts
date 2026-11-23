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
  readLocal: 'question-runs:read-local',
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
  interactionContract: z.literal('user-input-v1').optional(),
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
/** 현재 질문 또는 기존 공개 검색어 하나만 받습니다. 위키·첨부·이전 대화는 받지 않습니다. */
export const questionWebSearchSchema = z.union([
  questionSessionSchema.extend({ query: z.string().trim().min(1).max(200) }),
  questionSessionSchema.extend({
    question: z.string().trim().min(1).max(16000),
  }),
]);
export type QuestionWebSearchRequest = z.infer<typeof questionWebSearchSchema>;
export type QuestionWebSearchInput =
  | { query: string; question?: never }
  | { question: string; query?: never };
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
  /** 이번 앱 프로세스에서 로컬 변경을 정렬하는 번호입니다. 저장 판본은 아닙니다. */
  sequence?: number;
  status: 'idle' | 'running' | 'stopping' | 'exited' | 'failed';
  phase: string;
  preview: string;
  /** AI가 공개용으로 작성한 이번 실행의 임시 작업 설명입니다. */
  commentaries?: QuestionCommentary[];
  requestId: string | null;
  errorCode: string | null;
  cleanupWarning: boolean;
  /** AI 세션 이어가기가 실패해 전체 대화로 다시 시작했는지 나타냅니다. */
  resumeFailed?: boolean;
  /** 새 세션에 앞선 대화를 전달하기 시작한 실행에서만 참이다. */
  historyReplayed?: boolean;
};
export const questionCommentarySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .refine((value: string): boolean => !!value.trim()),
  content: z
    .string()
    .min(1)
    .max(2000)
    .refine((value: string): boolean => !!value.trim()),
});
export type QuestionCommentary = z.infer<typeof questionCommentarySchema>;
const questionClarificationOptionDetailSchema = z.strictObject({
  option: z.string().min(1).max(200),
  description: z
    .string()
    .min(1)
    .max(400)
    .refine(
      (value: string): boolean =>
        !!value.trim() &&
        !value.includes('[[') &&
        !value.includes('wiki-template-result'),
    ),
  recommended: z.boolean(),
});
export type QuestionClarificationOptionDetail = z.infer<
  typeof questionClarificationOptionDetailSchema
>;
/** 서버가 저장한 추가 질문만 입력 대기로 표시하며 공개 진행 문장과 구분합니다. */
export const questionClarificationSchema = z
  .strictObject({
    options: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .refine((value: string): boolean => !!value.trim()),
      )
      .max(3),
    option_details: z
      .array(questionClarificationOptionDetailSchema)
      .max(3)
      .optional(),
  })
  .refine(
    (value: {
      options: string[];
      option_details?: QuestionClarificationOptionDetail[];
    }): boolean => {
      if (value.option_details === undefined) return true;
      const details = value.option_details;
      return (
        new Set(value.options).size === value.options.length &&
        value.options.every(
          (option: string): boolean =>
            !option.includes('[[') && !option.includes('wiki-template-result'),
        ) &&
        details.every((detail: QuestionClarificationOptionDetail): boolean =>
          value.options.includes(detail.option),
        ) &&
        new Set(
          details.map(
            (detail: QuestionClarificationOptionDetail): string =>
              detail.option,
          ),
        ).size === details.length &&
        details.filter(
          (detail: QuestionClarificationOptionDetail): boolean =>
            detail.recommended,
        ).length <= 1
      );
    },
  );
export type QuestionClarification = z.infer<typeof questionClarificationSchema>;
export type QuestionAnswer = {
  turnId: string;
  content: string;
  citations: KnowledgeValue[];
  clarification?: QuestionClarification;
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
export type QuestionLocalResult = QuestionOutcome<{
  runId: string;
  local: QuestionLocal;
} | null>;
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
  readLocal: (request: QuestionReadRequest) => Promise<QuestionLocalResult>;
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

const questionLocalSchema = z.object({
  sequence: z.number().int().nonnegative().optional(),
  status: z.enum(['idle', 'running', 'stopping', 'exited', 'failed']),
  phase: z.string(),
  preview: z.string(),
  commentaries: z.array(questionCommentarySchema).max(20).optional(),
  requestId: id.nullable(),
  errorCode: z.string().nullable(),
  cleanupWarning: z.boolean(),
  resumeFailed: z.boolean().optional(),
  historyReplayed: z.boolean().optional(),
});
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
      clarification: questionClarificationSchema.optional(),
    }),
  ),
  answerReadError: z.string().nullable(),
  local: questionLocalSchema,
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
/** 서버 답변과 분리한 실행 중 미저장 스냅샷을 검사합니다. */
export function parseQuestionLocalResult(value: unknown): QuestionLocalResult {
  return z
    .union([
      z.object({
        ok: z.literal(true),
        data: z.object({ runId: id, local: questionLocalSchema }).nullable(),
      }),
      questionFailureSchema,
    ])
    .parse(value);
}
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
