import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  conversionProgressSchema,
  conversionReportSchema,
} from '@contracts/sourceConversion.contract';
import type {
  ConversionSource,
  SourceConversionRun,
} from '@contracts/sourceConversion.contract';
import { sourceFormatSchema } from '@contracts/documents.contract';

export const conversionCliEventSchema = z.discriminatedUnion('type', [
  conversionProgressSchema.extend({
    schema_version: z.literal(1),
    type: z.literal('progress'),
  }),
  z.object({
    schema_version: z.literal(1),
    type: z.literal('error'),
    error: z.object({ code: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/) }),
  }),
  z.object({
    schema_version: z.literal(1),
    type: z.literal('result'),
    request_id: z.string().regex(/^[a-f0-9]{32}$/),
    source_ref: z.object({
      source_id: z.string(),
      source_version: z.string(),
      source_sha256: z.string(),
      registration_revision: z.string(),
    }),
    state: z.enum([
      'complete',
      'partial',
      'failed',
      'cancelled',
      'report_unconfirmed',
    ]),
    format: sourceFormatSchema.nullable(),
    conversion: conversionReportSchema.nullable(),
    error: z
      .object({ code: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/) })
      .optional(),
    receipt: z.object({
      state: z.enum(['saved', 'not_submitted', 'unconfirmed', 'rejected']),
      error: z
        .object({ code: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/) })
        .optional(),
    }),
  }),
]);
export const conversionStoredSchema = z.object({
  data: z.object({
    manifest: z.object({
      id: z.string().regex(/^[a-f0-9]{32}$/),
      kind: z.literal('conversions'),
      user_id: z.string(),
      tenant: z.string(),
      request_id: z.string(),
      source_ref: z.object({
        source_id: z.string(),
        source_version: z.string(),
        source_sha256: z.string(),
        registration_revision: z.string(),
      }),
      method: conversionReportSchema.shape.method.unwrap(),
      complete: z.boolean(),
      unread_ranges: conversionReportSchema.shape.unread_ranges,
      warnings: conversionReportSchema.shape.warnings,
      origin: z.literal('client_reported'),
      coverage: z.literal('reported_units_only'),
      original_coverage: z.literal('not_verified'),
      semantic_validation: z.literal('not_run'),
      units: z
        .array(
          conversionReportSchema.shape.units.element.omit({ content: true }),
        )
        .max(1000),
    }),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    components: z.record(z.string(), z.string().max(4 * 1024 * 1024)),
    access: z.object({
      user_id: z.string(),
      tenant: z.string(),
      profile_id: z.string(),
      policy_revision: z.string(),
      access_revision: z
        .string()
        .min(1)
        .nullish()
        .transform(
          (value: string | null | undefined): string | undefined =>
            value ?? undefined,
        ),
    }),
  }),
});

/** 서버의 stable_id와 같은 방식으로 본인 요청의 조회 ID만 계산합니다. */
export function conversionId(
  tenant: string,
  userId: string,
  requestId: string,
): string {
  return createHash('sha256')
    .update(['conversions', tenant, userId, requestId].join(':'))
    .digest('hex')
    .slice(0, 32);
}
/** CLI나 서버 응답의 고정 원본을 요청과 대조합니다. */
export function matchesConversionSource(
  source: ConversionSource,
  actual: {
    source_id: string;
    source_version: string;
    source_sha256: string;
    registration_revision: string;
  },
): boolean {
  return (
    source.sourceId === actual.source_id &&
    source.sourceVersion === actual.source_version &&
    source.sourceSha256 === actual.source_sha256 &&
    source.registrationRevision === actual.registration_revision
  );
}
/** 완료 상태를 사람 검증이나 원본 전체 포함으로 표시하지 않습니다. */
export function conversionMessage(state: SourceConversionRun['state']): string {
  switch (state) {
    case 'running':
      return '이 PC에서 원본을 내려받아 문자를 변환하고 있습니다.';
    case 'cancelling':
      return '취소를 요청했습니다. 진행 중인 저장 결과는 따로 확인합니다.';
    case 'complete':
      return '변환 보고를 저장했습니다. 문자 정확도와 원본 전체 포함은 검증하지 않았습니다.';
    case 'partial':
      return '일부 구간만 변환했습니다. 미독 구간과 보고 저장 상태를 확인해 주세요.';
    case 'cancelled':
      return '변환을 중단했습니다. 이미 받은 원본과 변환 결과는 이 PC에 보존됩니다.';
    case 'report_unconfirmed':
      return '보고 저장 결과를 확인하지 못했습니다. 상태 확인은 같은 보고를 조회하며 재전송하지 않습니다.';
    case 'failed':
      return '변환을 완료하지 못했습니다. 설치 상태와 미독 구간을 확인해 주세요.';
  }
}
