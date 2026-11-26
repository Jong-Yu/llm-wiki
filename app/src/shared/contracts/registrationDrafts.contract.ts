import { z } from 'zod';
import {
  notificationSessionSchema,
  notificationSourceSchema,
  notificationConversionRefSchema,
} from './notifications.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const registrationContentOriginsSchema = z.record(
  z.string(),
  z.object({
    method: z.enum(['manual', 'ocr']),
    warnings: z.array(z.string().max(1024)).max(100),
  }),
);
export const REGISTRATION_DRAFT_CHANNELS = {
  get: 'registration-drafts:get',
  save: 'registration-drafts:save',
  clear: 'registration-drafts:clear',
} as const;
export const registrationDraftIdentitySchema = z.strictObject({
  workflowId: id,
  sourceRef: notificationSourceSchema,
  conversionRef: notificationConversionRefSchema.nullable(),
});
// 작성 중인 빈 문자열과 원래 기준을 보존하며 서버 등록 시점의 검증을 대신하지 않습니다.
export const registrationDraftSchema = z.strictObject({
  basisRevision: revision,
  basisContents: z.record(z.string(), z.string()),
  contents: z.record(z.string(), z.string()),
  contentOrigins: registrationContentOriginsSchema.optional(),
  blankUnits: z.array(z.string()),
  targetDocument: z.string(),
  submission: z.json().nullable(),
});
export const registrationDraftGetSchema = notificationSessionSchema.extend(
  registrationDraftIdentitySchema.shape,
);
export const registrationDraftSaveSchema = registrationDraftGetSchema.extend({
  expectedRevision: revision.nullable(),
  requestId: id,
  draft: registrationDraftSchema,
});
export const registrationDraftClearSchema = registrationDraftGetSchema.extend({
  expectedRevision: revision.nullable(),
  requestId: id,
  reason: z.enum(['registered', 'discarded']),
});
export const registrationDraftResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      draft: registrationDraftSchema.nullable(),
      revision: revision.nullable(),
      savedAt: z.iso.datetime().nullable(),
      cleared: z.enum(['registered', 'discarded']).nullable(),
      cleanupWarningCount: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type RegistrationDraftIdentity = z.infer<
  typeof registrationDraftIdentitySchema
>;
export type RegistrationDraft = z.infer<typeof registrationDraftSchema>;
export type RegistrationContentOrigins = z.infer<
  typeof registrationContentOriginsSchema
>;
export type RegistrationDraftGetRequest = z.infer<
  typeof registrationDraftGetSchema
>;
export type RegistrationDraftSaveRequest = z.infer<
  typeof registrationDraftSaveSchema
>;
export type RegistrationDraftClearRequest = z.infer<
  typeof registrationDraftClearSchema
>;
export type RegistrationDraftResult = z.infer<
  typeof registrationDraftResultSchema
>;
export type RegistrationDraftsBridge = {
  get: (
    request: RegistrationDraftGetRequest,
  ) => Promise<RegistrationDraftResult>;
  save: (
    request: RegistrationDraftSaveRequest,
  ) => Promise<RegistrationDraftResult>;
  clear: (
    request: RegistrationDraftClearRequest,
  ) => Promise<RegistrationDraftResult>;
};
