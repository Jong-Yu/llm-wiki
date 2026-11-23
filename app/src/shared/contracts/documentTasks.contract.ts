import { z } from 'zod';
import { isDocumentPath, sourceItemSchema } from './documents.contract';
import { sourceExpectedScopeSchema } from './sources.contract';
import {
  conversionSourceSchema,
  sourceConversionRunSchema,
} from './sourceConversion.contract';
import { analysisDetailSchema } from './analysis.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const timestamp = z.iso.datetime();
const failure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().optional(),
  }),
});
export const DOCUMENT_TASK_CHANNELS = {
  create: 'document-tasks:create',
  list: 'document-tasks:list',
  read: 'document-tasks:read',
};
export const documentTaskSessionSchema = z.strictObject({
  connectionId: z.string().min(1).max(4096),
  expectedScope: sourceExpectedScopeSchema,
});
export const documentTaskCreateSchema = documentTaskSessionSchema.extend({
  item: sourceItemSchema,
  targetDocument: z.string().min(1).max(4096).refine(isDocumentPath),
});
export const documentTaskReadSchema = documentTaskSessionSchema.extend({
  taskId: id,
});
// 보고의 본문은 기존 서버 보고에서 읽으며 로컬 작업 색인에는 복제하지 않습니다.
export const documentConversionAttemptSchema = sourceConversionRunSchema
  .omit({ report: true })
  .extend({
    startedAt: timestamp,
    updatedAt: timestamp,
    reportSummary: z
      .object({
        complete: z.boolean(),
        unreadRanges: z.array(z.string()),
        warnings: z.array(z.string()),
      })
      .nullable(),
  });
export const documentTaskSchema = z.strictObject({
  taskId: id,
  source: conversionSourceSchema,
  item: sourceItemSchema,
  targetDocument: z.string().min(1).max(4096).refine(isDocumentPath),
  createdAt: timestamp,
  updatedAt: timestamp,
  conversions: z.array(documentConversionAttemptSchema),
  analysisSummary: z
    .object({
      state: z.string(),
      reportedStatus: z.string().nullable(),
      resultStatus: z.string(),
      basisStatus: z.string(),
      updatedAt: timestamp,
    })
    .nullable(),
  registration: z.strictObject({
    requestId: id,
    state: z.enum(['not_started', 'unconfirmed', 'linked', 'rejected']),
    jobId: id.nullable(),
    errorCode: z.string().nullable(),
  }),
});
export const documentTaskResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: documentTaskSchema }),
  failure,
]);
export const documentTaskListResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      items: z.array(documentTaskSchema),
      scope: z.literal('this_device'),
      cleanupWarningCount: z.number().int().nonnegative(),
    }),
  }),
  failure,
]);
export const documentTaskDetailResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      task: documentTaskSchema,
      conversion: sourceConversionRunSchema.nullable(),
      analysis: analysisDetailSchema.nullable(),
      errors: z.array(
        z.object({
          stage: z.enum(['conversion', 'analysis', 'source']),
          code: z.string(),
          message: z.string(),
        }),
      ),
    }),
  }),
  failure,
]);
export type DocumentTaskSession = z.infer<typeof documentTaskSessionSchema>;
export type DocumentTaskCreateRequest = z.infer<
  typeof documentTaskCreateSchema
>;
export type DocumentTaskReadRequest = z.infer<typeof documentTaskReadSchema>;
export type DocumentTask = z.infer<typeof documentTaskSchema>;
export type DocumentConversionAttempt = z.infer<
  typeof documentConversionAttemptSchema
>;
export type DocumentTaskResult = z.infer<typeof documentTaskResultSchema>;
export type DocumentTaskListResult = z.infer<
  typeof documentTaskListResultSchema
>;
export type DocumentTaskDetailResult = z.infer<
  typeof documentTaskDetailResultSchema
>;
export type DocumentTasksBridge = {
  create: (request: DocumentTaskCreateRequest) => Promise<DocumentTaskResult>;
  list: (request: DocumentTaskSession) => Promise<DocumentTaskListResult>;
  read: (request: DocumentTaskReadRequest) => Promise<DocumentTaskDetailResult>;
};
