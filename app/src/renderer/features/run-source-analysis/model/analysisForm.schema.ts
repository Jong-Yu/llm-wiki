import { z } from 'zod';
import { isDocumentPath } from '@contracts/documents.contract';

/** 폼의 입력 검사와 TypeScript 입력 타입을 같은 정의에서 만듭니다. */
export const analysisFormSchema = z.object({
  targetDocument: z
    .string()
    .trim()
    .min(1, '저장할 위키 경로를 입력해 주세요.')
    .max(4096, '위키 경로가 너무 깁니다.')
    .refine(isDocumentPath, '폴더/문서.md 형태의 상대 경로를 입력해 주세요.'),
  outputs: z.enum(['wiki_ontology', 'wiki', 'ontology']),
});

export type AnalysisFormValues = z.infer<typeof analysisFormSchema>;

/** 원본 이름으로 저장 경로를 추정하지 않고 사용자가 대상을 명시하게 합니다. */
export function createAnalysisFormValues(): AnalysisFormValues {
  return { targetDocument: '', outputs: 'wiki_ontology' };
}
