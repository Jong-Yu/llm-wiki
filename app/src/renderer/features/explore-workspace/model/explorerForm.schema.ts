import { z } from 'zod';

export type ExplorerMode = 'knowledge' | 'review' | 'history' | 'questions';
export const explorerFormSchema = z
  .object({
    operation: z.enum([
      'conceptFind',
      'search',
      'ontology',
      'context',
      'connections',
      'impact',
    ]),
    query: z.string().max(200),
    documents: z.array(z.string()).max(8, '문서는 최대 8개까지 선택해 주세요.'),
    requiredDocuments: z.array(z.string()).max(8),
    sourceIds: z.array(z.string()).max(4),
    claims: z.array(z.string()).max(100),
    states: z
      .array(z.enum(['unreviewed', 'defer', 'pending']))
      .min(1, '조회할 상태를 선택해 주세요.'),
    correspondenceIds: z.string().max(4096),
    jobIds: z.string().max(4096),
    includeHistory: z.boolean(),
    expansion: z.boolean(),
    limit: z.number().int().min(1).max(100),
  })
  .superRefine(
    (
      value: { correspondenceIds: string; jobIds: string },
      context: z.RefinementCtx,
    ): void => {
      for (const key of ['correspondenceIds', 'jobIds']) {
        const raw =
          key === 'correspondenceIds' ? value.correspondenceIds : value.jobIds;
        const ids = splitReferences(raw);
        if (ids.length > 8 || new Set(ids).size !== ids.length)
          context.addIssue({
            code: 'custom',
            path: [key],
            message: '중복 없이 최대 8개 참조만 입력해 주세요.',
          });
        if (
          key === 'jobIds' &&
          ids.some((id: string): boolean => !/^[a-f0-9]{32}$/.test(id))
        )
          context.addIssue({
            code: 'custom',
            path: [key],
            message: '작업 번호는 서버에서 받은 32자리 번호를 입력해 주세요.',
          });
        if (
          key === 'correspondenceIds' &&
          ids.some(
            (id: string): boolean =>
              !/^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(id),
          )
        )
          context.addIssue({
            code: 'custom',
            path: [key],
            message: '문서 대응은 서버에서 받은 32자리 식별자를 입력해 주세요.',
          });
      }
    },
  );
export type ExplorerValues = z.infer<typeof explorerFormSchema>;

/** 입력한 참조는 사용자가 명시한 순서와 범위를 유지합니다. */
export function splitReferences(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .filter((item: string): boolean => item.length > 0);
}

/** 화면별 초안은 실제 조회 전까지 빈 선택에서 시작합니다. */
export function explorerDefaults(): ExplorerValues {
  return {
    operation: 'conceptFind',
    query: '',
    documents: [],
    requiredDocuments: [],
    sourceIds: [],
    claims: [],
    states: ['unreviewed', 'defer', 'pending'],
    correspondenceIds: '',
    jobIds: '',
    includeHistory: false,
    expansion: false,
    limit: 20,
  };
}
