import { z } from 'zod';

const MAX_WIKI_BYTES = 1024 * 1024;
export const wikiEditorSchema = z.object({
  content: z
    .string()
    .max(MAX_WIKI_BYTES)
    .refine(
      (value: string): boolean =>
        new TextEncoder().encode(value).byteLength <= MAX_WIKI_BYTES,
      '본문은 UTF-8 1 MiB 이내여야 합니다.',
    ),
});
export type WikiEditorValues = z.infer<typeof wikiEditorSchema>;
