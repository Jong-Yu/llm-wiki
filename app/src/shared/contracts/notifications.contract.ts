import { z } from 'zod';
import { isDocumentPath, sourceFormatSchema } from './documents.contract';
import { sourceExpectedScopeSchema } from './sources.contract';
import { conversionReportSchema } from './sourceConversion.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096);
const timestamp = z.string().min(1).max(100);
export const notificationCorrectionRefSchema = z.object({
  correction_id: id,
  correction_revision: revision,
});
export const notificationLocationFields = {
  page: z.number().int().min(1).max(100000).optional(),
  unit_id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),
  whole_document: z.literal(true).optional(),
};
export type NotificationLocation = {
  page?: number;
  unit_id?: string;
  whole_document?: true;
};
/** 하나의 보정이 가리키는 원본 위치를 배타적으로 검증합니다. */
export function validNotificationLocation(
  value: NotificationLocation,
): boolean {
  return (
    [value.page, value.unit_id, value.whole_document].filter(
      (part: number | string | boolean | undefined): boolean =>
        part !== undefined,
    ).length === 1
  );
}
/** 화면·저장·응답 확인에서 같은 위치 식별자를 사용합니다. */
export function notificationLocationKey(value: NotificationLocation): string {
  if (value.page !== undefined) return `page:${value.page}`;
  if (value.unit_id !== undefined) return `unit:${value.unit_id}`;
  return 'whole_document';
}
/** 부가 상태를 제외하고 원본 위치만 요청에 전달합니다. */
export function notificationLocation(
  value: NotificationLocation,
): NotificationLocation {
  if (value.page !== undefined) return { page: value.page };
  if (value.unit_id !== undefined) return { unit_id: value.unit_id };
  return { whole_document: true };
}
const correctionSelection = z
  .object({
    ...notificationLocationFields,
    correction_ref: notificationCorrectionRefSchema,
  })
  .refine(validNotificationLocation);
export const NOTIFICATION_CHANNELS = {
  list: 'notifications:list',
  read: 'notifications:read',
  markRead: 'notifications:mark-read',
  dismiss: 'notifications:dismiss',
  decide: 'notifications:decide',
  approve: 'notifications:approve',
  inspect: 'notifications:inspect',
  continue: 'notifications:continue',
  page: 'notifications:page',
  correct: 'notifications:correct',
  retryPage: 'notifications:retry-page',
  recoverImages: 'notifications:recover-images',
  cancelRetry: 'notifications:cancel-retry',
} as const;
export const notificationSessionSchema = z.strictObject({
  connectionId: text,
  expectedScope: sourceExpectedScopeSchema,
});
export const notificationListSchema = notificationSessionSchema.extend({
  filter: z.enum(['all', 'unread', 'approval']).optional(),
  cursor: z.string().min(1).max(16384).nullable().optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const notificationReadSchema = notificationSessionSchema.extend({
  workflowId: id,
});
export const notificationMarkReadSchema = notificationSessionSchema.extend({
  notificationIds: z.array(id).min(1).max(100),
  read: z.boolean(),
});
export const notificationDismissSchema = notificationSessionSchema.extend({
  notificationIds: z.array(id).min(1).max(100),
});
const mutation = notificationReadSchema.extend({
  requestId: id,
  expectedRevision: revision,
});
export const notificationDecideSchema = mutation.extend({
  decisions: z
    .array(
      z
        .strictObject({
          ...notificationLocationFields,
          state: z.enum(['pending', 'usable', 'held']),
          correction_ref: notificationCorrectionRefSchema.optional(),
        })
        .refine(validNotificationLocation),
    )
    .min(1)
    .max(1000),
});
export const notificationApproveSchema = mutation.extend({
  targetDocument: text.refine(isDocumentPath).optional(),
  correctionRefs: z.array(correctionSelection).max(1000).optional(),
  correctionsRevision: revision.optional(),
});
export const notificationContinueSchema = mutation;
export const notificationContentSchema = z
  .string()
  .max(4 * 1024 * 1024)
  .refine((value: string): boolean => !value.includes('\0'))
  .refine(
    (value: string): boolean =>
      new TextEncoder().encode(value).byteLength <= 4 * 1024 * 1024,
  );
const correctionWarnings = z.array(z.string().max(1024)).max(100);
export const notificationCorrectSchema = mutation
  .extend({
    ...notificationLocationFields,
    content: notificationContentSchema,
    method: z.enum(['manual', 'ocr', 'blank']),
    warnings: correctionWarnings.optional(),
  })
  .refine(validNotificationLocation)
  .refine(
    (
      value: NotificationLocation & {
        method: 'manual' | 'ocr' | 'blank';
        content: string;
      },
    ): boolean =>
      value.method === 'blank'
        ? value.content === '' && !value.whole_document
        : !!value.content.trim(),
  );
export const notificationRetryPageSchema = mutation.extend({
  page: z.number().int().min(1).max(100000),
});
export const notificationRecoverImagesSchema = mutation;
export const notificationCancelRetrySchema = notificationReadSchema.extend({
  requestId: id,
});
export const notificationPageSchema = notificationReadSchema.extend({
  page: z.number().int().min(1).max(1000000),
});
export const notificationSourceSchema = z.object({
  source_id: id,
  source_version: id,
  source_sha256: revision,
  registration_revision: revision,
});
export const notificationConversionRefSchema = z.object({
  conversion_id: id,
  conversion_revision: revision,
});
export const notificationAccessSchema = z.object({
  user_id: text,
  tenant: text,
  profile_id: text,
  policy_revision: revision,
  access_revision: z.string().min(1).nullish(),
});
export const notificationWorkflowSchema = z.object({
  workflow_id: id,
  revision,
  source_ref: notificationSourceSchema,
  conversion_ref: notificationConversionRefSchema.nullable(),
  title: text,
  target_document: text.refine(isDocumentPath).nullable(),
  blocked_reason: z.enum(['source_changed', 'report_changed']).optional(),
  state: z.enum([
    'review',
    'approved',
    'claimed',
    'running',
    'complete',
    'failed',
    'stopped',
  ]),
  corrections_revision: revision.optional(),
  pages: z
    .array(
      z
        .object({
          ...notificationLocationFields,
          state: z.enum(['pending', 'usable', 'held']),
          input_required: z.boolean().optional(),
          correction_ref: notificationCorrectionRefSchema.optional(),
        })
        .refine(validNotificationLocation),
    )
    .max(10101),
  approval: z
    .object({
      request_id: id,
      approved_at: timestamp,
      actor: z.object({ user_id: text, tenant: text, profile_id: text }),
      device_id: id,
      device_name: z.string().max(80),
    })
    .nullable(),
  execution: z
    .object({
      claim_id: id.nullable(),
      device_id: id.nullable(),
      device_name: z.string().max(80).nullable(),
      claimed_at: timestamp.nullable(),
      job_id: id.nullable(),
    })
    .nullable(),
  resume_request_id: id,
  created_at: timestamp,
  updated_at: timestamp,
});
export const notificationItemSchema = z.object({
  notification_id: id,
  workflow_id: id,
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['approval_required', 'completed', 'failed', 'stopped']),
  origin: z.enum(['server', 'client_reported']).optional(),
  created_at: timestamp,
  read_at: timestamp.nullable(),
  title: text,
  state: z.string().min(1).max(100),
  blocked_reason: z.enum(['source_changed', 'report_changed']).optional(),
  warning_count: z.number().int().nonnegative(),
  source_ref: notificationSourceSchema,
  conversion_ref: notificationConversionRefSchema.nullable(),
});
export const notificationListDataSchema = z.object({
  items: z.array(notificationItemSchema).max(100),
  next_cursor: z.string().nullable(),
  unread_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative().optional(),
  approval_count: z.number().int().nonnegative(),
  latest_sequence: z.number().int().nonnegative(),
  refresh_required: z.boolean().optional(),
  access: notificationAccessSchema,
});
export const notificationDetailDataSchema = z.object({
  sourcePageCount: z.number().int().min(1).max(1000000).nullable().optional(),
  source_format: sourceFormatSchema.nullable().optional(),
  workflow: notificationWorkflowSchema,
  corrections: z
    .array(
      z
        .object({
          correction_ref: notificationCorrectionRefSchema,
          ...notificationLocationFields,
          content: notificationContentSchema,
          method: z.enum(['manual', 'ocr', 'blank']),
          warnings: correctionWarnings,
          created_at: timestamp,
          request_id: id.optional(),
        })
        .refine(validNotificationLocation),
    )
    .max(10101)
    .default([]),
  events: z
    .array(
      z.object({
        event_id: id,
        kind: z.string(),
        created_at: timestamp,
        actor: z.object({ user_id: text, tenant: text, profile_id: text }),
        details: z
          .object({
            diagnostic_codes: z
              .array(z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/))
              .max(100)
              .optional(),
          })
          .optional(),
      }),
    )
    .max(10000),
  conversion: z
    .object({
      manifest: z.object({
        id,
        source_ref: notificationSourceSchema,
        method: conversionReportSchema.shape.method,
        complete: z.boolean(),
        unread_ranges: conversionReportSchema.shape.unread_ranges,
        warnings: conversionReportSchema.shape.warnings,
        units: z
          .array(
            conversionReportSchema.shape.units.element.omit({ content: true }),
          )
          .max(10000),
      }),
      revision,
      components: z.record(z.string(), z.string().max(4 * 1024 * 1024)),
    })
    .nullable(),
  access: notificationAccessSchema,
});
export const notificationMutationDataSchema = z.object({
  workflow: notificationWorkflowSchema,
  replayed: z.boolean(),
  access: notificationAccessSchema,
});
export const notificationReadStateDataSchema = z.object({
  updated: z.number().int().nonnegative(),
  access: notificationAccessSchema,
});
export const notificationInspectionDataSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(z.string()),
  deviceId: id,
  deviceName: z.string().max(80),
  checkedAt: timestamp,
});
export const notificationContinueDataSchema = z.object({
  workflow: notificationWorkflowSchema,
  jobId: id,
  started: z.boolean(),
});
export const notificationPageDataSchema = z.object({
  page: z.number().int().min(1),
  dataUrl: z
    .string()
    .startsWith('data:image/png;base64,')
    .max(12 * 1024 * 1024),
});
const failure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: text,
    message: z.string().max(4096),
    status: z.number().optional(),
    traceId: z.string().optional(),
  }),
});
export const notificationListResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationListDataSchema }),
  failure,
]);
export const notificationDetailResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationDetailDataSchema }),
  failure,
]);
export const notificationMutationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationMutationDataSchema }),
  failure,
]);
export const notificationReadStateResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationReadStateDataSchema }),
  failure,
]);
export const notificationInspectionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationInspectionDataSchema }),
  failure,
]);
export const notificationContinueResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationContinueDataSchema }),
  failure,
]);
export const notificationPageResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: notificationPageDataSchema }),
  failure,
]);
export const notificationRetryPageResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      page: z.number().int().min(1),
      content: z.string().max(4 * 1024 * 1024),
      warnings: correctionWarnings,
    }),
  }),
  failure,
]);
export const notificationCancelRetryResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.object({ cancelled: z.boolean() }) }),
  failure,
]);
export const notificationRecoverImagesDataSchema = z.object({
  units: z
    .array(
      z.object({
        unit_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        content: notificationContentSchema.refine(
          (value: string): boolean => !!value.trim(),
        ),
        warnings: correctionWarnings,
      }),
    )
    .max(40)
    .refine(
      (units: { unit_id: string; content: string }[]): boolean =>
        new Set(units.map((unit: { unit_id: string }): string => unit.unit_id))
          .size === units.length &&
        units.reduce(
          (total: number, unit: { content: string }): number =>
            total + new TextEncoder().encode(unit.content).byteLength,
          0,
        ) <=
          20 * 1024 * 1024,
    ),
  warnings: correctionWarnings,
  provider: z.enum(['codex', 'claude']),
  model: z.string().min(1).max(200).nullable(),
});
export const notificationRecoverImagesResultSchema = z.discriminatedUnion(
  'ok',
  [
    z.object({
      ok: z.literal(true),
      data: notificationRecoverImagesDataSchema,
    }),
    failure,
  ],
);
export type NotificationRecoverImagesRequest = z.infer<
  typeof notificationRecoverImagesSchema
>;
export type NotificationRecoverImagesResult = z.infer<
  typeof notificationRecoverImagesResultSchema
>;
export type NotificationCorrectRequest = z.infer<
  typeof notificationCorrectSchema
>;
export type NotificationRetryPageRequest = z.infer<
  typeof notificationRetryPageSchema
>;
export type NotificationCancelRetryRequest = z.infer<
  typeof notificationCancelRetrySchema
>;
export type NotificationRetryPageResult = z.infer<
  typeof notificationRetryPageResultSchema
>;
export type NotificationCancelRetryResult = z.infer<
  typeof notificationCancelRetryResultSchema
>;
export type NotificationSession = z.infer<typeof notificationSessionSchema>;
export type NotificationListRequest = z.infer<typeof notificationListSchema>;
export type NotificationReadRequest = z.infer<typeof notificationReadSchema>;
export type NotificationMarkReadRequest = z.infer<
  typeof notificationMarkReadSchema
>;
export type NotificationDismissRequest = z.infer<
  typeof notificationDismissSchema
>;
export type NotificationDecideRequest = z.infer<
  typeof notificationDecideSchema
>;
export type NotificationApproveRequest = z.infer<
  typeof notificationApproveSchema
>;
export type NotificationContinueRequest = z.infer<
  typeof notificationContinueSchema
>;
export type NotificationPageRequest = z.infer<typeof notificationPageSchema>;
export type NotificationItem = z.infer<typeof notificationItemSchema>;
export type NotificationWorkflow = z.infer<typeof notificationWorkflowSchema>;
export type NotificationListResult = z.infer<
  typeof notificationListResultSchema
>;
export type NotificationDetailResult = z.infer<
  typeof notificationDetailResultSchema
>;
export type NotificationMutationResult = z.infer<
  typeof notificationMutationResultSchema
>;
export type NotificationReadStateResult = z.infer<
  typeof notificationReadStateResultSchema
>;
export type NotificationInspectionResult = z.infer<
  typeof notificationInspectionResultSchema
>;
export type NotificationContinueResult = z.infer<
  typeof notificationContinueResultSchema
>;
export type NotificationPageResult = z.infer<
  typeof notificationPageResultSchema
>;
export type NotificationsBridge = {
  recoverImages: (
    request: NotificationRecoverImagesRequest,
  ) => Promise<NotificationRecoverImagesResult>;
  correct: (
    request: NotificationCorrectRequest,
  ) => Promise<NotificationMutationResult>;
  retryPage: (
    request: NotificationRetryPageRequest,
  ) => Promise<NotificationRetryPageResult>;
  cancelRetry: (
    request: NotificationCancelRetryRequest,
  ) => Promise<NotificationCancelRetryResult>;
  list: (request: NotificationListRequest) => Promise<NotificationListResult>;
  read: (request: NotificationReadRequest) => Promise<NotificationDetailResult>;
  markRead: (
    request: NotificationMarkReadRequest,
  ) => Promise<NotificationReadStateResult>;
  dismiss: (
    request: NotificationDismissRequest,
  ) => Promise<NotificationReadStateResult>;
  decide: (
    request: NotificationDecideRequest,
  ) => Promise<NotificationMutationResult>;
  approve: (
    request: NotificationApproveRequest,
  ) => Promise<NotificationMutationResult>;
  inspect: (
    request: NotificationReadRequest,
  ) => Promise<NotificationInspectionResult>;
  continue: (
    request: NotificationContinueRequest,
  ) => Promise<NotificationContinueResult>;
  page: (request: NotificationPageRequest) => Promise<NotificationPageResult>;
};
