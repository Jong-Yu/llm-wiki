import { z } from 'zod';

export const UPDATE_CHANNELS = {
  status: 'update:status',
  install: 'update:install',
} as const;

/** 앱 업데이트 진행 상태입니다. ready일 때만 설치할 수 있습니다. */
export const updateStatusSchema = z.strictObject({
  state: z.enum(['idle', 'downloading', 'ready']),
  version: z.string().min(1).max(64).optional(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updateResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: updateStatusSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(['forbidden', 'invalid_request', 'not_ready']),
      message: z.string().max(500),
    }),
  }),
]);
export type UpdateResult = z.infer<typeof updateResultSchema>;

/** 상태 조회와 내려받은 업데이트 설치만 허용하며 주소·파일 경로를 받지 않습니다. */
export type UpdateBridge = {
  getStatus: () => Promise<UpdateResult>;
  install: () => Promise<UpdateResult>;
};
