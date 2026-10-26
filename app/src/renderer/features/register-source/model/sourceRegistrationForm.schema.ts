import { z } from 'zod';
import { MAX_SOURCE_BYTES } from '@contracts/documents.contract';
import {
  sourceTextFieldsSchema,
  sourceFileFieldsSchema,
} from '@contracts/sources.contract';

export const sourceRegistrationFormSchema = z
  .object({
    kind: z.enum(['file', 'text']),
    title: sourceTextFieldsSchema.shape.title,
    format: sourceTextFieldsSchema.shape.format,
    content: z.string(),
    fileId: z.string(),
  })
  .superRefine(
    (
      value: {
        kind: 'file' | 'text';
        title: string;
        format: 'md' | 'txt';
        content: string;
        fileId: string;
      },
      context: z.RefinementCtx,
    ): void => {
      if (
        value.kind === 'file' &&
        !sourceFileFieldsSchema.shape.fileId.safeParse(value.fileId).success
      )
        context.addIssue({
          code: 'custom',
          path: ['fileId'],
          message: '등록할 파일을 선택해 주세요.',
        });
      if (
        value.kind === 'text' &&
        new TextEncoder().encode(value.content).byteLength > MAX_SOURCE_BYTES
      )
        context.addIssue({
          code: 'custom',
          path: ['content'],
          message: '원본은 UTF-8 20 MiB 이내여야 합니다.',
        });
    },
  );
export type SourceRegistrationValues = z.infer<
  typeof sourceRegistrationFormSchema
>;

/** 입력 방식 전환은 각 초안을 보존하며 새 등록만 빈 값에서 시작합니다. */
export function initialSourceRegistrationValues(): SourceRegistrationValues {
  return { kind: 'file', title: '', format: 'md', content: '', fileId: '' };
}
