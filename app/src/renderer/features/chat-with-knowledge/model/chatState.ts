import { ATTACHMENT_COUNT_LIMIT } from './attachments';
import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { QuestionDetail } from '@contracts/questionRuns.contract';
import { isDocumentPath } from '@contracts/documents.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const chatQuestionSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, '질문을 입력해 주세요.')
    .max(16000, '질문은 16,000자 이내로 입력해 주세요.'),
});
/** 외부에 전달할 검색어는 질문·첨부에서 자동 생성하지 않고 사용자가 별도로 정합니다. */
export const chatWebQuerySchema = z
  .string()
  .trim()
  .min(1, '외부에서 찾아볼 검색어를 입력해 주세요.')
  .max(200, '외부 검색어는 200자 이내로 입력해 주세요.');
/** 웹 설정 폼은 공개 검색어만 검증하며 선택 상태는 대화 초안이 소유합니다. */
export const chatWebSearchFormSchema = z.object({
  webQuery: chatWebQuerySchema,
});
export type ChatWebSearchForm = z.infer<typeof chatWebSearchFormSchema>;
export const chatTurnSchema = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum(['complete', 'failed']).optional(),
  citations: z.array(knowledgeValueSchema).optional(),
  basis: knowledgeValueSchema.optional(),
  reply_to: id.nullable().optional(),
});
export const chatEnvelopeSchema = z.object({
  record: z.object({
    id,
    kind: z.enum(['conversations', 'saved-results']),
    tenant: z.string(),
    user_id: z.string(),
    data: knowledgeValueSchema,
    events: z.array(knowledgeValueSchema),
    requests: z.record(z.string(), z.string()),
  }),
  revision,
});
export type ChatEnvelope = z.infer<typeof chatEnvelopeSchema>;
export type ChatTurn = z.infer<typeof chatTurnSchema>;
const attachmentSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['text', 'file']),
  name: z.string().min(1).max(200),
  text: z.string().max(12000),
  truncated: z.boolean(),
});
const chatThreadBase = z.object({
  id,
  title: z.string(),
  draft: z.string(),
  /** 이전 버전의 자료 한 덩어리입니다. 읽을 때 첨부 칩 하나로 옮기며 새로 쓰지 않습니다. */
  material: z.string().max(12000).default(''),
  /** 질문과 함께 보낼 첨부 자료(붙여넣은 글·파일에서 읽은 글)입니다. 여러 개 둘 수 있습니다. */
  attachments: z
    .array(attachmentSchema)
    .max(ATTACHMENT_COUNT_LIMIT)
    .default([]),
  /** 다음 질문에만 적용할 출력 양식 번호이며 없으면 빈 값입니다. */
  template: z.string().max(40).default(''),
  webEnabled: z.boolean().default(false),
  webQuery: z.string().max(200).default(''),
  draftRevision: revision.nullable().default(null),
  conversationId: id.nullable(),
  questionTurnId: id.nullable(),
  runId: id.nullable(),
  startUnconfirmed: z.boolean().default(false),
  noEvidenceQuestion: z.string().nullable(),
  searchNotice: z.string(),
  documents: z.array(z.string().refine(isDocumentPath)).max(8).default([]),
});
type ChatThreadInput = z.output<typeof chatThreadBase>;
const chatThreadSchema = chatThreadBase.transform(
  ({
    material,
    ...thread
  }: ChatThreadInput): Omit<ChatThreadInput, 'material'> => ({
    ...thread,
    attachments:
      material && thread.attachments.length === 0
        ? [
            {
              id: 'legacy',
              kind: 'text',
              name: '붙여넣은 텍스트 #1',
              text: material,
              truncated: false,
            },
          ]
        : thread.attachments,
  }),
);
export type ChatThread = z.output<typeof chatThreadSchema>;
export const chatRecoverySchema = z.object({
  activeId: id,
  threads: z.array(chatThreadSchema).min(1).max(100),
  pending: z
    .object({
      step: z.enum(['conversation', 'question', 'run', 'artifact']),
      requestId: id,
      recordId: id.nullable(),
      threadId: id,
      sentQuestion: z.string().optional(),
    })
    .nullable(),
});
export type ChatRecovery = z.infer<typeof chatRecoverySchema>;
export type ChatPending = NonNullable<ChatRecovery['pending']>;

/** 개인 기록의 요청 식별자를 생성하며 본문이나 인증정보를 포함하지 않습니다. */
export function chatId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}
/** 새 대화는 첫 질문을 보내기 전까지 서버 기록을 만들지 않습니다. */
export function emptyChat(): ChatThread {
  return {
    id: chatId(),
    title: '새 대화',
    draft: '',
    attachments: [],
    template: '',
    webEnabled: false,
    webQuery: '',
    draftRevision: null,
    conversationId: null,
    questionTurnId: null,
    runId: null,
    startUnconfirmed: false,
    noEvidenceQuestion: null,
    searchNotice: '',
    documents: [],
  };
}
/** 사용자·답변 이벤트만 검증해 렌더링하고 알 수 없는 이벤트를 답변으로 만들지 않습니다. */
export function chatTurns(record: ChatEnvelope | null): ChatTurn[] {
  if (!record) return [];
  return record.record.events.map((event: unknown): ChatTurn =>
    chatTurnSchema.parse(event),
  );
}
/** 답변 저장 결과가 미확인인 실행은 새 요청으로 우회하지 않습니다. */
export function chatRunUncertain(run: QuestionDetail): boolean {
  return (
    run.receipts.some(
      (receipt: QuestionDetail['receipts'][number]): boolean =>
        receipt.saved === null,
    ) ||
    (run.local.requestId !== null &&
      !run.receipts.some(
        (receipt: QuestionDetail['receipts'][number]): boolean =>
          receipt.request_id === run.local.requestId && receipt.saved !== null,
      ))
  );
}
/** 로컬 프로세스와 서버 사용권 중 하나라도 살아 있으면 실행 중으로 표시합니다. */
export function chatRunActive(run: QuestionDetail | null): boolean {
  return (
    run !== null &&
    (run.local.status === 'running' ||
      run.local.status === 'stopping' ||
      (run.status === 'running' && run.leaseStatus === 'active'))
  );
}
/** 재시도는 저장 증거 없는 대기/만료 상태에 한해서 같은 실행을 사용합니다. */
export function chatRunStartable(run: QuestionDetail): boolean {
  return (
    !chatRunActive(run) &&
    run.receipts.length === 0 &&
    run.local.requestId === null &&
    (run.status === 'queued' ||
      (run.status === 'running' && run.leaseStatus === 'expired'))
  );
}
