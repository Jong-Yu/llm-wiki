import { z } from 'zod';

export const titleFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '제목을 입력해 주세요.')
    .max(200, '제목은 200자 이내입니다.'),
});
export const contextFormSchema = z.object({
  documents: z
    .array(z.string().min(1))
    .min(1, '근거 문서를 선택해 주세요.')
    .max(8),
});
export const questionSourceSchema = z.object({
  source_id: z.string().regex(/^[a-f0-9]{32}$/),
  source_version: z.string().regex(/^[a-f0-9]{32}$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  conversion_ref: z
    .object({
      conversion_id: z.string().regex(/^[a-f0-9]{32}$/),
      conversion_revision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export type QuestionSource = z.infer<typeof questionSourceSchema>;
export const questionFormSchema = z
  .object({
    content: z.string().min(1, '질문을 입력해 주세요.').max(65536),
    documents: z.array(z.string().min(1)).max(8),
    sources: z.array(questionSourceSchema).max(4),
  })
  .refine(
    (value: { documents: string[]; sources: QuestionSource[] }): boolean =>
      value.documents.length + value.sources.length > 0,
    {
      path: ['documents'],
      message: '근거 문서 또는 고정 원본 판본을 선택해 주세요.',
    },
  );
export const resultFormSchema = titleFormSchema.extend({
  content: z.string().min(1, '보관할 내용을 입력해 주세요.').max(65536),
  documents: contextFormSchema.shape.documents,
});
export const answerFormSchema = z
  .object({
    replyTo: z.string().regex(/^[a-f0-9]{32}$/, '저장된 질문을 선택해 주세요.'),
    content: z.string().max(65536),
    status: z.enum(['complete', 'failed']),
  })
  .refine(
    (value: { status: 'complete' | 'failed'; content: string }): boolean =>
      value.status === 'failed' || value.content.length > 0,
    {
      path: ['content'],
      message: '답변 내용을 입력하거나 실패 기록으로 선택해 주세요.',
    },
  );
export const mappingFormSchema = z
  .object({
    document: z.string().min(1, '문서를 선택해 주세요.'),
    disposition: z.enum(['same', 'changed', 'missing', 'new']),
    oldClaim: z.string(),
    newClaim: z.string(),
    reason: z.string().trim().min(1, '판단 이유를 입력해 주세요.').max(1000),
  })
  .superRefine(
    (
      value: {
        disposition: 'same' | 'changed' | 'missing' | 'new';
        oldClaim: string;
        newClaim: string;
      },
      context: z.RefinementCtx,
    ): void => {
      if (value.disposition !== 'new' && !/^[a-f0-9]{64}$/.test(value.oldClaim))
        context.addIssue({
          code: 'custom',
          path: ['oldClaim'],
          message: '이전 주장을 선택해 주세요.',
        });
      if (
        value.disposition !== 'missing' &&
        !/^[a-f0-9]{64}$/.test(value.newClaim)
      )
        context.addIssue({
          code: 'custom',
          path: ['newClaim'],
          message: '새 주장을 선택해 주세요.',
        });
    },
  );
export const completionFormSchema = z.object({
  outcome: z.enum(['reviewed', 'deferred']),
  reason: z
    .string()
    .trim()
    .min(1, '완료 또는 보류 이유를 입력해 주세요.')
    .max(1000),
  selected: z.array(z.string()).max(100),
});
export type TitleFormValues = z.infer<typeof titleFormSchema>;
export type QuestionFormValues = z.infer<typeof questionFormSchema>;
export type ResultFormValues = z.infer<typeof resultFormSchema>;
export type AnswerFormValues = z.infer<typeof answerFormSchema>;
export type MappingFormValues = z.infer<typeof mappingFormSchema>;
export type CompletionFormValues = z.infer<typeof completionFormSchema>;
