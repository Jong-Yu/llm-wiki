import { z } from 'zod';
import { notificationReadSchema } from './notifications.contract';

export const SOURCE_VISUAL_PREVIEW_CHANNELS = {
  read: 'source-visual-previews:read',
  release: 'source-visual-previews:release',
} as const;
export const sourceVisualPreviewRequestSchema = notificationReadSchema.extend({
  previewId: z.string().regex(/^[a-f0-9]{32}$/),
  page: z.number().int().min(1).max(100000),
});
export const sourceVisualPreviewReleaseSchema = z.strictObject({
  previewId: z.string().regex(/^[a-f0-9]{32}$/),
});
const failure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().optional(),
  }),
});
export const sourceVisualPreviewResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      previewId: z.string().regex(/^[a-f0-9]{32}$/),
      page: z.number().int().min(1).max(100000),
      pageCount: z.number().int().min(1).max(100000),
      kind: z.enum(['office', 'image']),
      limited: z.boolean(),
      dataUrl: z
        .string()
        .max(12 * 1024 * 1024)
        .startsWith('data:image/png;base64,'),
    }),
  }),
  failure,
]);
export const sourceVisualPreviewReleaseResultSchema = z.discriminatedUnion(
  'ok',
  [z.object({ ok: z.literal(true) }), failure],
);
export type SourceVisualPreviewRequest = z.infer<
  typeof sourceVisualPreviewRequestSchema
>;
export type SourceVisualPreviewReleaseRequest = z.infer<
  typeof sourceVisualPreviewReleaseSchema
>;
export type SourceVisualPreviewResult = z.infer<
  typeof sourceVisualPreviewResultSchema
>;
export type SourceVisualPreviewReleaseResult = z.infer<
  typeof sourceVisualPreviewReleaseResultSchema
>;
export type SourceVisualPreviewsBridge = {
  read: (
    request: SourceVisualPreviewRequest,
  ) => Promise<SourceVisualPreviewResult>;
  release: (
    request: SourceVisualPreviewReleaseRequest,
  ) => Promise<SourceVisualPreviewReleaseResult>;
};
