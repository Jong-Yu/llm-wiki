import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import { questionReceiptSchema } from '@contracts/questionRuns.contract';
import type {
  QuestionDetail,
  QuestionLocal,
  QuestionSession,
  QuestionAnswer,
  QuestionEvidence,
} from '@contracts/questionRuns.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema = z.object({
  document: z.string(),
  source_revision: revision,
  knowledge: z.object({
    graph_revision: revision.nullable(),
    state_revision: revision,
  }),
});
const originalSchema = z.object({
  source_ref: z.object({
    source_id: id,
    source_version: id,
    source_sha256: revision,
  }),
});
export const questionServerSchema = z.object({
  record: z.object({
    id,
    kind: z.literal('question-runs'),
    tenant: z.string(),
    user_id: z.string(),
    actor: z.object({ profile_id: z.string() }),
    data: z.object({
      conversation_id: id,
      question_turn_id: id,
      question: z.string(),
      basis: z.object({
        snapshot_revision: revision,
        documents: z.array(documentSchema),
        originals: z.array(originalSchema).default([]),
      }),
    }),
  }),
  state_revision: revision,
  runtime: z.object({
    status: z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']),
    progress: z.string(),
  }),
  lease_status: z.enum(['none', 'active', 'expired']),
  answer_requests: z.array(questionReceiptSchema),
  human_approval: z.literal(false),
  server_ai_executed: z.literal(false),
});
const answerEventSchema = z.object({
  id,
  role: z.literal('assistant'),
  content: z.string(),
  question_run_id: id,
  reply_to: id,
  origin: z.literal('client_reported'),
  human_approval: z.literal(false),
  citations: z.array(knowledgeValueSchema),
});
const conversationSchema = z.object({
  record: z.object({
    id,
    kind: z.literal('conversations'),
    tenant: z.string(),
    user_id: z.string(),
    events: z.array(z.unknown()),
  }),
});

/** 실행하지 않은 로컬 상태를 만들며 서버 이력 조회에서 AI 실행을 추정하지 않습니다. */
export function idleQuestionLocal(): QuestionLocal {
  return {
    status: 'idle',
    phase: '',
    preview: '',
    requestId: null,
    errorCode: null,
    cleanupWarning: false,
  };
}
/** 전체 고정 원문은 main에서 검사하고 renderer에는 판본 참조와 저장 증거만 보냅니다. */
export function projectQuestion(
  value: unknown,
  session: QuestionSession,
  expectedId?: string,
): QuestionDetail {
  const run = questionServerSchema.parse(value);
  if (
    run.record.tenant !== session.expectedScope.tenant ||
    run.record.user_id !== session.expectedScope.userId ||
    run.record.actor.profile_id !== session.expectedScope.profileId ||
    (expectedId && run.record.id !== expectedId)
  )
    throw new Error('scope_changed');
  const data = run.record.data;
  for (const receipt of run.answer_requests) {
    if (
      receipt.record_id !== run.record.id ||
      (receipt.receipt &&
        (receipt.receipt.question_run_id !== run.record.id ||
          receipt.receipt.conversation_id !== data.conversation_id ||
          receipt.receipt.basis_snapshot_revision !==
            data.basis.snapshot_revision))
    )
      throw new Error('receipt_mismatch');
    if (receipt.saved === true && !receipt.receipt)
      throw new Error('receipt_missing');
  }
  return {
    id: run.record.id,
    conversationId: data.conversation_id,
    questionTurnId: data.question_turn_id,
    question: data.question,
    profileId: run.record.actor.profile_id,
    basisRevision: data.basis.snapshot_revision,
    evidence: [
      ...data.basis.documents.map(
        (doc: z.infer<typeof documentSchema>): QuestionEvidence => ({
          kind: 'document',
          label: doc.document,
          sourceRevision: doc.source_revision,
          graphRevision: doc.knowledge.graph_revision,
          stateRevision: doc.knowledge.state_revision,
          sourceId: null,
          sourceVersion: null,
        }),
      ),
      ...data.basis.originals.map(
        (original: z.infer<typeof originalSchema>): QuestionEvidence => ({
          kind: 'source',
          label: original.source_ref.source_id,
          sourceRevision: original.source_ref.source_sha256,
          graphRevision: null,
          stateRevision: null,
          sourceId: original.source_ref.source_id,
          sourceVersion: original.source_ref.source_version,
        }),
      ),
    ],
    stateRevision: run.state_revision,
    status: run.runtime.status,
    progress: run.runtime.progress,
    leaseStatus: run.lease_status,
    receipts: run.answer_requests,
    answers: [],
    answerReadError: null,
    local: idleQuestionLocal(),
  };
}
/** 실제 영수증의 답변 ID·질문 계보와 일치하는 대화 이벤트만 저장 답변으로 보여 줍니다. */
export function projectQuestionAnswers(
  value: unknown,
  detail: QuestionDetail,
  session: QuestionSession,
): QuestionAnswer[] {
  const conversation = conversationSchema.parse(value).record;
  if (
    conversation.id !== detail.conversationId ||
    conversation.tenant !== session.expectedScope.tenant ||
    conversation.user_id !== session.expectedScope.userId
  )
    throw new Error('scope_changed');
  const answers: QuestionAnswer[] = [];
  for (const receipt of detail.receipts) {
    if (receipt.saved !== true || !receipt.receipt) continue;
    const event = conversation.events
      .map((raw: unknown): z.infer<typeof answerEventSchema> | null => {
        const parsed = answerEventSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      })
      .find(
        (item: z.infer<typeof answerEventSchema> | null): boolean =>
          item?.id === receipt.receipt?.answer_turn_id,
      );
    if (
      !event ||
      event.question_run_id !== detail.id ||
      event.reply_to !== detail.questionTurnId
    )
      throw new Error('answer_mismatch');
    answers.push({
      turnId: event.id,
      content: event.content,
      citations: event.citations,
    });
  }
  return answers;
}
const cliEventSchema = z.object({
  protocol: z.literal('question-cli-v1'),
  type: z.enum(['phase', 'answer_preview', 'answer_request', 'result']),
  question_run_id: id.nullish(),
  phase: z.string().max(100).optional(),
  content: z.string().max(65536).optional(),
  saved: z.boolean().nullable().optional(),
  request_id: id.nullish(),
  error: z
    .union([
      z.string().regex(/^[a-z0-9_]{1,128}$/),
      z.object({ code: z.string().regex(/^[a-z0-9_]{1,128}$/) }),
    ])
    .nullish(),
  origin: z.literal('client_reported').optional(),
});
/** CLI 표준 출력은 임시 진행으로만 읽습니다. stdout의 saved=true로 저장 답변을 만들지 않습니다. */
export function applyQuestionCliEvent(
  local: QuestionLocal,
  value: unknown,
  questionRunId: string,
): QuestionLocal {
  const parsed = cliEventSchema.safeParse(value);
  if (!parsed.success) return local;
  const event = parsed.data;
  if (event.question_run_id && event.question_run_id !== questionRunId)
    return local;
  if (event.type === 'answer_preview') {
    if (
      event.saved !== false ||
      event.origin !== 'client_reported' ||
      event.content === undefined
    )
      return local;
    return { ...local, preview: event.content };
  }
  if (event.type === 'phase')
    return { ...local, phase: event.phase ?? local.phase };
  if (event.type === 'answer_request')
    return { ...local, requestId: event.request_id ?? local.requestId };
  return {
    ...local,
    requestId: event.request_id ?? local.requestId,
    errorCode:
      typeof event.error === 'string'
        ? event.error
        : (event.error?.code ?? null),
  };
}
