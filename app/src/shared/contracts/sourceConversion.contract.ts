import { z } from 'zod';
import { sourceFormatSchema } from './documents.contract';
import { sourceExpectedScopeSchema } from './sources.contract';
import type { SourceExpectedScope } from './sources.contract';
export type SourceConversionScope = SourceExpectedScope & {
  connectionId: string;
};
import { analysisLocationSchema } from './workspace.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const SOURCE_CONVERSION_CHANNELS = {
  start: 'source-conversion:start',
  read: 'source-conversion:read',
  cancel: 'source-conversion:cancel',
};
export const conversionSourceSchema = z.strictObject({
  sourceId: id,
  sourceVersion: id,
  sourceSha256: revision,
  registrationRevision: revision,
});
export const sourceConversionReadSchema = conversionSourceSchema.extend({
  connectionId: z.string().min(1).max(4096),
  expectedScope: sourceExpectedScopeSchema,
  taskId: id.optional(),
});
export const sourceConversionStartSchema = sourceConversionReadSchema.extend({
  ocr: z.enum(['auto', 'never', 'always']),
  ocrLanguage: z
    .string()
    .regex(/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/)
    .max(100),
});
export const sourceConversionCancelSchema = sourceConversionReadSchema.extend({
  requestId: id,
});
export const conversionReferenceSchema = conversionSourceSchema.extend({
  conversionId: id,
  conversionRevision: revision,
  requestId: id,
});
export const conversionUnitSchema = z.object({
  unit_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  location: analysisLocationSchema,
  content: z.string().max(4 * 1024 * 1024),
});
export const conversionReportSchema = z
  .object({
    method: z
      .enum([
        'verbatim',
        'pdf_text',
        'ocr',
        'xlsx_values',
        'docx_text',
        'pptx_text',
      ])
      .nullable(),
    units: z.array(conversionUnitSchema).max(10000),
    complete: z.boolean(),
    unread_ranges: z.array(z.string().max(1000)).max(100),
    warnings: z.array(z.string().max(1000)).max(100),
    origin: z.literal('client_reported'),
    coverage: z.literal('reported_units_only'),
    original_coverage: z.literal('not_verified'),
    semantic_validation: z.literal('not_run'),
    diagnostics: z
      .array(
        z.object({
          code: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
          scope: z.string().max(1000).optional(),
          unread: z.boolean().optional(),
        }),
      )
      .max(100)
      .default([]),
    unit_methods: z.record(z.string().max(64), z.string().max(100)).default({}),
  })
  .refine(
    (report: {
      units: { content: string; unit_id: string }[];
      complete: boolean;
      method: string | null;
      unread_ranges: string[];
    }): boolean =>
      (report.method !== null ||
        (!report.complete && report.units.length === 0)) &&
      (!report.complete ||
        (report.unread_ranges.length === 0 && report.units.length > 0)) &&
      new Set(
        report.units.map((unit: { unit_id: string }): string => unit.unit_id),
      ).size === report.units.length &&
      report.units.reduce(
        (size: number, unit: { content: string }): number =>
          size + new TextEncoder().encode(unit.content).byteLength,
        0,
      ) <=
        20 * 1024 * 1024,
  );
export const conversionProgressSchema = z.object({
  stage: z.enum(['download', 'convert', 'submit']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable().optional(),
  location: z
    .union([analysisLocationSchema, z.string().max(1000)])
    .nullable()
    .optional(),
});
export const sourceConversionRunSchema = z.object({
  requestId: id,
  source: conversionSourceSchema,
  state: z.enum([
    'running',
    'cancelling',
    'complete',
    'partial',
    'failed',
    'cancelled',
    'report_unconfirmed',
  ]),
  format: sourceFormatSchema.nullable(),
  progress: conversionProgressSchema.nullable(),
  report: conversionReportSchema.nullable(),
  receiptState: z.enum([
    'pending',
    'saved',
    'not_submitted',
    'unconfirmed',
    'rejected',
  ]),
  reference: conversionReferenceSchema.nullable(),
  message: z.string().max(2000),
  diagnosticCodes: z
    .array(z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/))
    .max(100),
  cleanupWarning: z.boolean(),
  historyWarning: z.string().max(2000).optional(),
  canResumeUpload: z.boolean().optional(),
});
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: sourceConversionRunSchema.nullable() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(128),
      message: z.string().max(4096),
      status: z.number().int().optional(),
      traceId: id.optional(),
    }),
  }),
]);
export type ConversionSource = z.infer<typeof conversionSourceSchema>;
export type SourceConversionReadRequest = z.infer<
  typeof sourceConversionReadSchema
>;
export type SourceConversionStartRequest = z.infer<
  typeof sourceConversionStartSchema
>;
export type SourceConversionCancelRequest = z.infer<
  typeof sourceConversionCancelSchema
>;
export type SourceConversionRun = z.infer<typeof sourceConversionRunSchema>;
export type ConversionReviewReport = Pick<
  NonNullable<SourceConversionRun['report']>,
  'complete' | 'unread_ranges' | 'warnings'
>;
/** 보존된 OCR 문자의 저신뢰만 구분하며 원본 전체 포함이나 정확도를 승인하지 않습니다. */
export function conversionNeedsTextReview(
  report: ConversionReviewReport | null | undefined,
): boolean {
  return (
    report?.complete === false &&
    report.unread_ranges.length > 0 &&
    report.unread_ranges.every((range: string): boolean =>
      /^(?:page|slide|frame) [1-9][0-9]*: ocr_low_or_missing_confidence_text_retained_manual_review_required$/.test(
        range,
      ),
    ) &&
    !report.warnings.some((warning: string): boolean =>
      warning.includes('worker:'),
    )
  );
}

/** 불완전한 변환의 명시 누락은 원인별 해결 또는 내용 입력 화면에서 확인합니다. */
export function conversionNeedsContentReview(
  report: ConversionReviewReport | null | undefined,
): boolean {
  return report?.complete === false && report.unread_ranges.length > 0;
}

/** 첫 승인 범위는 원본 페이지를 대조할 수 있는 PDF 쪽 보고로 한정합니다. */
export function conversionNeedsPageApproval(
  report: ConversionReviewReport | null | undefined,
): boolean {
  return (
    conversionNeedsTextReview(report) &&
    !!report?.unread_ranges.every((range: string): boolean =>
      range.startsWith('page '),
    )
  );
}
export type SourceConversionResult = z.infer<typeof resultSchema>;
export type SourceConversionBridge = {
  start: (
    request: SourceConversionStartRequest,
  ) => Promise<SourceConversionResult>;
  read: (
    request: SourceConversionReadRequest,
  ) => Promise<SourceConversionResult>;
  cancel: (
    request: SourceConversionCancelRequest,
  ) => Promise<SourceConversionResult>;
};
/** 경로·바이너리·인증 비밀을 포함하지 않는 변환 상태만 preload에 전달합니다. */
export function parseSourceConversionResult(
  value: unknown,
): SourceConversionResult {
  return resultSchema.parse(value);
}
