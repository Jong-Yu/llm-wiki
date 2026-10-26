import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';

export const RECOVERY_CHANNELS: { readonly execute: 'recovery:execute' } = {
  execute: 'recovery:execute',
};
export const recoveryKindSchema = z.enum([
  'result-drafts',
  'question-runs',
  'source-conversions',
  'analysis-proposals',
  'pending-result-draft',
  'pending-question-run',
  'pending-source-conversion',
  'pending-analysis',
]);
export type RecoveryKind = z.infer<typeof recoveryKindSchema>;
const key = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const payload = z
  .string()
  .max(8 * 1024 * 1024)
  .refine((value: string): boolean => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  });
export const recoveryEntrySchema = z.strictObject({
  kind: recoveryKindSchema,
  key,
  payload,
  revision,
  savedAt: z.iso.datetime(),
});
export type RecoveryEntry = z.infer<typeof recoveryEntrySchema>;
const scope = {
  connectionId: z.string().min(1).max(4096),
  expectedScope: workspaceScopeSchema,
  kind: recoveryKindSchema,
};
export const recoveryRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...scope, operation: z.literal('list') }),
  z.strictObject({
    ...scope,
    operation: z.literal('put'),
    key,
    payload,
    expectedRevision: revision.nullable(),
  }),
  z.strictObject({
    ...scope,
    operation: z.literal('remove'),
    key,
    expectedRevision: revision,
  }),
]);
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export const recoveryResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      entries: z.array(recoveryEntrySchema),
      cleanupWarningCount: z.number().int().min(0),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4096),
    }),
  }),
]);
export type RecoveryResult = z.infer<typeof recoveryResultSchema>;
export type RecoveryBridge = {
  execute: (request: RecoveryRequest) => Promise<RecoveryResult>;
};
/** IPC 복구 결과는 공개된 데이터와 안전한 오류만 전달합니다. */
export function parseRecoveryResult(value: unknown): RecoveryResult {
  return recoveryResultSchema.parse(value);
}
