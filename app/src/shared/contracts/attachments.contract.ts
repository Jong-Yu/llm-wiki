import { z } from 'zod';

/** 파일 선택과 preload가 실제 드롭에서 확인한 파일의 읽기를 구분합니다. */
export const ATTACHMENT_CHANNELS = {
  pick: 'attachments:pick',
  drop: 'attachments:drop',
} as const;

/** 한 번에 담을 수 있는 글자 수만 전달합니다. 파일 경로·이름·형식은 받지 않습니다. */
export const attachmentPickRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(12000),
});
export type AttachmentPickRequest = z.infer<typeof attachmentPickRequestSchema>;

/** preload → main 전용 입력입니다. 화면에 노출하는 drop API는 경로 대신 File을 받습니다. */
export const attachmentDropIpcSchema = attachmentPickRequestSchema.extend({
  path: z
    .string()
    .min(1)
    .max(32767)
    .refine((path: string): boolean => !path.includes('\0')),
});

export const attachmentPickResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    /** 사용자가 선택을 취소하면 null입니다. */
    data: z
      .strictObject({
        name: z.string().min(1).max(200),
        text: z.string().max(40000),
        totalChars: z.number().int().nonnegative(),
        truncated: z.boolean(),
        /** 읽지 못한 부분을 알리는 고정 코드입니다. 파일 내용은 담지 않습니다. */
        notes: z.array(z.string().max(120)).max(20),
      })
      .nullable(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4096),
    }),
  }),
]);
export type AttachmentPickResult = z.infer<typeof attachmentPickResultSchema>;
export type AttachmentBridge = {
  pick: (request: AttachmentPickRequest) => Promise<AttachmentPickResult>;
  /** 네이티브 파일인지 판별하는 권한은 Electron preload에만 있습니다. */
  drop?: (
    file: unknown,
    request: AttachmentPickRequest,
  ) => Promise<AttachmentPickResult>;
};
