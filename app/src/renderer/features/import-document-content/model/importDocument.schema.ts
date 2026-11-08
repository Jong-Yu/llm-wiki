import { z } from 'zod';
import {
  isDocumentPath,
  MAX_SOURCE_BYTES,
} from '@contracts/documents.contract';
import {
  sourceTextFieldsSchema,
  sourceFileFieldsSchema,
} from '@contracts/sources.contract';

/** 등록 입력을 검증합니다. 제목은 붙여넣기에서만 입력받고 저장 이름은 제출 때 자동으로 정합니다. */
const importDocumentFieldsSchema = z.object({
  kind: z.enum(['file', 'text']),
  title: z.string(),
  content: z.string(),
  fileId: z.string(),
  targetDocument: z
    .string()
    .trim()
    .max(4096)
    .refine(
      (value: string): boolean => value === '' || isDocumentPath(value),
      '위키 안의 저장 이름을 입력하세요. 예: documents/운영-가이드.md',
    ),
  extract: z.boolean(),
});
export const importDocumentSchema = importDocumentFieldsSchema.superRefine(
  (
    value: z.infer<typeof importDocumentFieldsSchema>,
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
    if (value.kind === 'text') {
      const title = sourceTextFieldsSchema.shape.title.safeParse(value.title);
      if (!title.success)
        context.addIssue({
          code: 'custom',
          path: ['title'],
          message: title.error.issues[0]?.message ?? '제목을 입력해 주세요.',
        });
    }
    if (value.kind === 'text' && !value.content.trim())
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: '보관할 본문을 붙여넣어 주세요.',
      });
    if (
      value.kind === 'text' &&
      new TextEncoder().encode(value.content).byteLength > MAX_SOURCE_BYTES
    )
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: '본문은 UTF-8 20 MiB 이내여야 합니다.',
      });
  },
);
export type ImportDocumentValues = z.infer<typeof importDocumentSchema>;

/** 새 입력에서만 기본값을 사용하고 재시도에는 기존 초안을 유지합니다. */
export function initialImportValues(canExtract: boolean): ImportDocumentValues {
  return {
    kind: 'file',
    title: '',
    content: '',
    fileId: '',
    targetDocument: '',
    extract: canExtract,
  };
}
