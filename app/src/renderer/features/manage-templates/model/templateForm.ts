import { z } from 'zod';
import type { TemplateMetadata } from '@contracts/templates.contract';

export const templateFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '템플릿 이름을 입력해 주세요.')
    .max(200, '200자 이내로 입력해 주세요.'),
  filename: z.string().min(1, '양식 파일을 선택해 주세요.'),
  instructions: z.string().max(12000, '지침은 12,000자 이내로 입력해 주세요.'),
});
export type TemplateFormValues = z.infer<typeof templateFormSchema>;

/** 등록은 빈 입력, 편집은 읽은 판본의 이름·파일·지침으로 시작합니다. */
export function templateFormValues(
  template?: TemplateMetadata,
): TemplateFormValues {
  return template
    ? {
        name: template.name,
        filename: template.filename,
        instructions: template.instructions,
      }
    : { name: '', filename: '', instructions: '' };
}
