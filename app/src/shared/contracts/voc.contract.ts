import { z } from 'zod';

export const VOC_CHANNELS = { submit: 'voc:submit' } as const;

/** 서버의 JSON 수신 경계만 검사하고 입력한 보고 내용은 그대로 보존합니다. */
export const vocSubmitSchema = z.strictObject({
  connectionId: z.string().min(1).max(256),
  content: z
    .string()
    .max(8 * 1024 * 1024)
    .refine((value: string): boolean => value.trim().length > 0)
    .refine(
      (value: string): boolean =>
        new TextEncoder().encode(JSON.stringify({ content: value }))
          .byteLength <=
        8 * 1024 * 1024,
    ),
});
export const vocReceiptSchema = z.object({
  report_id: z.string().regex(/^[a-f0-9]{32}$/),
  created_at: z.iso.datetime({ offset: true }),
});
export const vocSubmitResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: vocReceiptSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(128),
      message: z.string().max(4096),
      status: z.number().optional(),
      traceId: z.string().optional(),
    }),
  }),
]);
export type VocSubmitRequest = z.infer<typeof vocSubmitSchema>;
export type VocSubmitResult = z.infer<typeof vocSubmitResultSchema>;
export type VocBridge = {
  submit: (request: VocSubmitRequest) => Promise<VocSubmitResult>;
};
