import { z } from 'zod';

export const RUNTIME_CHANNELS = { execute: 'runtime:execute' } as const;
export const aiProviderSchema = z.enum(['codex', 'claude']);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export const runtimePathKindSchema = z.enum([
  'root',
  'python',
  'codex',
  'claude',
  'tesseract',
  'tessdata',
]);
export type RuntimePathKind = z.infer<typeof runtimePathKindSchema>;
export const runtimeSettingsSchema = z
  .object({
    root: z.string().max(4096),
    python: z.string().max(4096),
    provider: aiProviderSchema,
    codex: z.string().max(4096),
    claude: z.string().max(4096),
    tesseract: z.string().max(4096),
    tessdata: z.string().max(4096),
  })
  .strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }).strict(),
  z
    .object({
      operation: z.literal('select-provider'),
      provider: aiProviderSchema,
    })
    .strict(),
  z
    .object({ operation: z.literal('choose'), kind: runtimePathKindSchema })
    .strict(),
  z.object({ operation: z.literal('save') }).strict(),
  z.object({ operation: z.literal('diagnose') }).strict(),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
const runtimeCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(['ok', 'missing', 'error', 'not_run']),
    detail: z.string(),
  })
  .strict();
export type RuntimeCheck = z.infer<typeof runtimeCheckSchema>;
const runtimeSnapshotSchema = z
  .object({
    settings: runtimeSettingsSchema,
    activeProvider: aiProviderSchema,
    restartRequired: z.boolean(),
    saved: z.boolean(),
    issue: z.string().nullable(),
    checks: z.array(runtimeCheckSchema),
    platform: z.string(),
  })
  .strict();
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
const runtimeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: runtimeSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);
export type RuntimeResult = z.infer<typeof runtimeResultSchema>;
export type RuntimeBridge = {
  execute: (request: RuntimeRequest) => Promise<RuntimeResult>;
};
/** 실행 환경 응답의 공개 필드만 통과시킵니다. */
export function parseRuntimeResult(value: unknown): RuntimeResult {
  return runtimeResultSchema.parse(value);
}
