import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';

export const TEMPLATES_CHANNELS = {
  list: 'templates:list',
  read: 'templates:read',
  chooseFile: 'templates:choose-file',
  save: 'templates:save',
  archive: 'templates:archive',
  downloadOriginal: 'templates:download-original',
  prepareResult: 'templates:prepare-result',
  downloadResult: 'templates:download-result',
} as const;

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value: string): boolean =>
      !/[\\/:]/.test(value) &&
      !Array.from(value).some(
        (character: string): boolean =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      value !== '.' &&
      value !== '..',
  );
const sizeBytes = z
  .number()
  .int()
  .min(0)
  .max(20 * 1024 * 1024);
const scope = {
  connectionId: z.string().min(1).max(4096),
  expectedScope: workspaceScopeSchema,
};
export const templateSessionSchema = z.strictObject(scope);
export const templateChooseFileSchema = z.strictObject({
  ...scope,
  previousFileId: id.optional(),
});
export const templateReadRequestSchema = z.strictObject({
  ...scope,
  templateId: id,
  revision: revision.optional(),
});
const templateSaveInputSchema = z.strictObject({
  ...scope,
  requestId: id,
  templateId: id.optional(),
  expectedRevision: revision.optional(),
  name: z.string().trim().min(1).max(200),
  instructions: z.string().max(12000),
  fileId: id.optional(),
});
export const templateSaveRequestSchema = templateSaveInputSchema.refine(
  (value: z.infer<typeof templateSaveInputSchema>): boolean =>
    value.templateId !== undefined
      ? value.expectedRevision !== undefined
      : value.expectedRevision === undefined && value.fileId !== undefined,
);
export const templateArchiveRequestSchema = z.strictObject({
  ...scope,
  templateId: id,
  expectedRevision: revision,
  requestId: id,
});
export const templateOriginalRequestSchema = z.strictObject({
  ...scope,
  templateId: id,
  revision,
});
export const templatePrepareResultRequestSchema = z.strictObject({
  ...scope,
  templateId: id,
  revision,
  content: z.string().min(1).max(65536),
});
export const templateDownloadResultRequestSchema = z.strictObject({
  ...scope,
  resultId: id,
});

export const templateMetadataSchema = z.object({
  id,
  revision,
  name: z.string().min(1).max(200),
  instructions: z.string().max(12000),
  filename,
  sizeBytes,
  sha256: revision,
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export const templateSummarySchema = templateMetadataSchema.omit({
  instructions: true,
});
export const templateGenerationSchema = z.object({
  supported: z.boolean(),
  format: z.string().nullable(),
  reason: z.string().nullable(),
  fields: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        text: z.string(),
        location: z.string().max(200).optional(),
      }),
    )
    .max(500),
});
export const templateDetailSchema = z.object({
  template: templateMetadataSchema,
  generation: templateGenerationSchema,
});
export const templateFileSchema = z.object({
  fileId: id,
  filename,
  sizeBytes,
  sha256: revision,
});
export const templatePreparedResultSchema = z.object({
  resultId: id,
  filename,
  sizeBytes,
  sha256: revision,
});
const error = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,128}$/),
  message: z.string().min(1).max(4096),
  status: z.number().int().min(100).max(599).optional(),
  traceId: id.optional(),
  retry: z.enum(['none', 'read_again', 'same_basis', 'reconcile']).optional(),
});
const failure = z.object({ ok: z.literal(false), error });
export const templateListResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      items: z.array(templateSummarySchema),
      complete: z.boolean(),
      truncated: z.boolean(),
    }),
  }),
  failure,
]);
export const templateDetailResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: templateDetailSchema }),
  failure,
]);
export const templateFileResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: templateFileSchema }),
  failure,
]);
export const templatePreparedResultResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: templatePreparedResultSchema }),
  failure,
]);
export const templateDownloadResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({ started: z.boolean(), warning: z.string().optional() }),
  }),
  failure,
]);
export type TemplateSession = z.infer<typeof templateSessionSchema>;
export type TemplateChooseFileRequest = z.infer<
  typeof templateChooseFileSchema
>;
export type TemplateReadRequest = z.infer<typeof templateReadRequestSchema>;
export type TemplateSaveRequest = z.infer<typeof templateSaveRequestSchema>;
export type TemplateArchiveRequest = z.infer<
  typeof templateArchiveRequestSchema
>;
export type TemplateOriginalRequest = z.infer<
  typeof templateOriginalRequestSchema
>;
export type TemplatePrepareResultRequest = z.infer<
  typeof templatePrepareResultRequestSchema
>;
export type TemplateDownloadResultRequest = z.infer<
  typeof templateDownloadResultRequestSchema
>;
export type TemplateMetadata = z.infer<typeof templateMetadataSchema>;
export type TemplateSummary = z.infer<typeof templateSummarySchema>;
export type TemplateGeneration = z.infer<typeof templateGenerationSchema>;
export type TemplateDetail = z.infer<typeof templateDetailSchema>;
export type TemplateFile = z.infer<typeof templateFileSchema>;
export type TemplatePreparedResult = z.infer<
  typeof templatePreparedResultSchema
>;
export type TemplateListResult = z.infer<typeof templateListResultSchema>;
export type TemplateDetailResult = z.infer<typeof templateDetailResultSchema>;
export type TemplateFileResult = z.infer<typeof templateFileResultSchema>;
export type TemplatePreparedResultResult = z.infer<
  typeof templatePreparedResultResultSchema
>;
export type TemplateDownloadResult = z.infer<
  typeof templateDownloadResultSchema
>;
export type TemplatesBridge = {
  list: (request: TemplateSession) => Promise<TemplateListResult>;
  read: (request: TemplateReadRequest) => Promise<TemplateDetailResult>;
  chooseFile: (
    request: TemplateChooseFileRequest,
  ) => Promise<TemplateFileResult>;
  save: (request: TemplateSaveRequest) => Promise<TemplateDetailResult>;
  archive: (request: TemplateArchiveRequest) => Promise<TemplateDetailResult>;
  downloadOriginal: (
    request: TemplateOriginalRequest,
  ) => Promise<TemplateDownloadResult>;
  prepareResult: (
    request: TemplatePrepareResultRequest,
  ) => Promise<TemplatePreparedResultResult>;
  downloadResult: (
    request: TemplateDownloadResultRequest,
  ) => Promise<TemplateDownloadResult>;
};
