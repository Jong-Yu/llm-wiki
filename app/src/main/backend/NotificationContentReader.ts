import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  notificationDetailDataSchema,
  notificationLocation,
  notificationLocationKey,
  notificationCorrectionRefSchema,
  notificationLocationFields,
  validNotificationLocation,
} from '@contracts/notifications.contract';
import type {
  NotificationDetailResult,
  NotificationWorkflow,
  NotificationLocation,
} from '@contracts/notifications.contract';
import type { AnalysisContext } from './ConnectionService';
import { apiFailure } from './readApi';
import type { ApiFailure, ReadApiResult } from './readApi';
import { conversionStoredSchema } from './sourceConversionProtocol';
import { readConversionParts } from './sourceConversionParts';

type ReadNotificationApi = (
  context: AnalysisContext,
  path: string,
) => Promise<ReadApiResult>;

/** 부분 조회의 권한 회수도 원래 실패 코드로 renderer에 전달합니다. */
class NotificationReadFailure extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(failure.error.message);
    this.failure = failure;
  }
}

type PageCorrection = Extract<
  NotificationDetailResult,
  { ok: true }
>['data']['corrections'][number];
const contentMetadata = z.object({ content_included: z.literal(false) });
const summarySchema = notificationDetailDataSchema.extend({
  corrections: z
    .array(
      z.object({
        ...notificationDetailDataSchema.shape.corrections.unwrap().element
          .shape,
        content: z.string().default(''),
        content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size_bytes: z.number().int().nonnegative(),
        total_characters: z.number().int().nonnegative(),
      }),
    )
    .max(10101),
});
const contentChunkSchema = z.object({
  workflow_revision: z.string(),
  target: z
    .object(notificationLocationFields)
    .refine(validNotificationLocation),
  variant: z.enum(['original', 'selected']),
  correction_ref: notificationCorrectionRefSchema.nullable(),
  exists: z.boolean(),
  content: z.string(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().nonnegative(),
  total_characters: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
});
const originalPageCountSchema = z.object({
  source_id: z.string(),
  source_version: z.string(),
  source_sha256: z.string(),
  registration_revision: z.string(),
  page_count: z.number().int().min(1).max(1000000),
});
/** 불변 참조와 판본을 확인하며 등록 본문을 복원합니다. 인증된 GET만 주입받습니다. */
export class NotificationContentReader {
  readonly #readApi: ReadNotificationApi;
  readonly #pageCounts = new Map<string, number | null>();

  constructor(readApi: ReadNotificationApi) {
    this.#readApi = readApi;
  }

  /** 전체 응답 또는 검증한 조각을 같은 본문으로 조립하고 원본 페이지 수를 연결합니다. */
  async read(
    context: AnalysisContext,
    workflowId: string,
  ): Promise<NotificationDetailResult> {
    let result = await this.#readApi(
      context,
      `notification-workflows/${workflowId}`,
    );
    if (
      !result.ok &&
      ['response_too_large', 'input_limit'].includes(result.error.code)
    )
      result = await this.#readApi(
        context,
        `notification-workflows/${workflowId}?include_content=false`,
      );
    if (!result.ok) return result;
    let data: Extract<NotificationDetailResult, { ok: true }>['data'];
    if (contentMetadata.safeParse(result.value).success) {
      const summary = summarySchema.parse(result.value);
      data = notificationDetailDataSchema.parse(summary);
      let originalLoaded = false;
      if (
        summary.workflow.conversion_ref &&
        summary.conversion?.manifest.method !== null
      ) {
        const original = await this.#readApi(
          context,
          `analysis-conversions/${summary.workflow.conversion_ref.conversion_id}`,
        );
        if (original.ok) {
          const stored = conversionStoredSchema.parse({
            data: original.value,
          }).data;
          if (
            stored.manifest.id !==
              summary.workflow.conversion_ref.conversion_id ||
            stored.revision !==
              summary.workflow.conversion_ref.conversion_revision ||
            stored.manifest.user_id !== context.active.userId ||
            stored.manifest.tenant !== context.selection.tenant ||
            JSON.stringify(stored.manifest.source_ref) !==
              JSON.stringify(summary.workflow.source_ref)
          )
            return apiFailure(
              'source_mismatch',
              '고정된 변환 보고를 확인하지 못했습니다.',
            );
          let resolved: Awaited<ReturnType<typeof readConversionParts>>;
          try {
            resolved = await readConversionParts(
              stored,
              async (partId: string): Promise<unknown> => {
                const part = await this.#readApi(
                  context,
                  `analysis-conversion-parts/${partId}`,
                );
                if (!part.ok) throw new NotificationReadFailure(part);
                return { data: part.value };
              },
            );
          } catch (cause: unknown) {
            if (cause instanceof NotificationReadFailure) return cause.failure;
            return apiFailure(
              'content_mismatch',
              '보관한 변환 내용의 전체 판본을 확인하지 못했습니다.',
            );
          }
          if (
            !data.conversion ||
            JSON.stringify(resolved.units) !==
              JSON.stringify(data.conversion.manifest.units)
          )
            return apiFailure(
              'source_mismatch',
              '원래 변환 위치와 보관한 내용을 연결하지 못했습니다.',
            );
          data.conversion.components = resolved.components;
          originalLoaded = true;
        } else if (
          !['response_too_large', 'input_limit'].includes(original.error.code)
        )
          return original;
      }
      if (!originalLoaded) {
        for (const unit of summary.conversion?.manifest.units ?? []) {
          const loaded = await this.#content(
            context,
            workflowId,
            summary.workflow.revision,
            { unit_id: unit.unit_id },
            'original',
          );
          if (!loaded.ok) return loaded;
          if (!loaded.exists || !data.conversion)
            return apiFailure(
              'content_missing',
              '보관한 변환 내용을 확인하지 못했습니다.',
            );
          data.conversion.components[unit.unit_id] = loaded.content;
        }
      }
      for (const [index, correction] of summary.corrections.entries()) {
        const loaded = await this.#content(
          context,
          workflowId,
          summary.workflow.revision,
          notificationLocation(correction),
          'selected',
        );
        if (!loaded.ok) return loaded;
        const item = data.corrections[index];
        if (
          !item ||
          loaded.sha256 !== correction.content_sha256 ||
          loaded.sizeBytes !== correction.size_bytes ||
          loaded.reference?.correction_id !==
            correction.correction_ref.correction_id ||
          loaded.reference.correction_revision !==
            correction.correction_ref.correction_revision
        )
          return apiFailure(
            'correction_mismatch',
            '수정 내용이 바뀌었습니다. 저장한 초안을 보존하고 상태를 다시 확인해 주세요.',
          );
        item.content = loaded.content;
      }
    } else data = notificationDetailDataSchema.parse(result.value);
    const { workflow, conversion } = data;
    if (
      workflow.workflow_id !== workflowId ||
      !!workflow.conversion_ref !== !!conversion ||
      (conversion &&
        workflow.conversion_ref &&
        (conversion.manifest.id !== workflow.conversion_ref.conversion_id ||
          conversion.revision !== workflow.conversion_ref.conversion_revision ||
          JSON.stringify(conversion.manifest.source_ref) !==
            JSON.stringify(workflow.source_ref)))
    )
      return apiFailure(
        'source_mismatch',
        '고정 원본과 변환 보고의 연결을 확인할 수 없습니다.',
      );
    const countKey = `${workflow.workflow_id}:${workflow.source_ref.registration_revision}`;
    if (!this.#pageCounts.has(countKey)) {
      const source = workflow.source_ref;
      const query = new URLSearchParams({
        source_sha256: source.source_sha256,
        registration_revision: source.registration_revision,
      });
      const metadata = await this.#readApi(
        context,
        `sources/${source.source_id}/versions/${source.source_version}/pages?${query.toString()}`,
      );
      if (metadata.ok) {
        const count = originalPageCountSchema.parse(metadata.value);
        if (
          count.source_id !== source.source_id ||
          count.source_version !== source.source_version ||
          count.source_sha256 !== source.source_sha256 ||
          count.registration_revision !== source.registration_revision
        )
          return apiFailure(
            'source_mismatch',
            '원본의 전체 페이지를 확인하지 못했습니다.',
          );
        if (this.#pageCounts.size >= 128) this.#pageCounts.clear();
        this.#pageCounts.set(countKey, count.page_count);
      } else if (
        metadata.error.status === 401 ||
        metadata.error.status === 403 ||
        metadata.error.status === 409
      )
        return metadata;
      else if (metadata.error.status === 415 || metadata.error.status === 404)
        this.#pageCounts.set(countKey, null);
    }
    data.sourcePageCount = this.#pageCounts.get(countKey) ?? null;
    const correctedPages = workflow.pages.filter(
      (page: NotificationWorkflow['pages'][number]): boolean =>
        !!page.correction_ref,
    );
    if (
      data.corrections.length !== correctedPages.length ||
      new Set(
        data.corrections.map((value: PageCorrection): string =>
          notificationLocationKey(value),
        ),
      ).size !== data.corrections.length ||
      correctedPages.some(
        (page: NotificationWorkflow['pages'][number]): boolean =>
          !data.corrections.some(
            (correction: PageCorrection): boolean =>
              notificationLocationKey(correction) ===
                notificationLocationKey(page) &&
              correction.correction_ref.correction_id ===
                page.correction_ref?.correction_id &&
              correction.correction_ref.correction_revision ===
                page.correction_ref?.correction_revision,
          ),
      )
    )
      return apiFailure(
        'correction_mismatch',
        '저장된 수정 문자와 검토 기록의 연결을 확인할 수 없습니다. 상태를 다시 확인해 주세요.',
      );
    return { ok: true, data };
  }

  /** 응답 경계를 넘는 전문은 고정 workflow 판본·hash를 확인하며 나누어 읽습니다. */
  async #content(
    context: AnalysisContext,
    workflowId: string,
    revision: string,
    target: NotificationLocation,
    variant: 'original' | 'selected',
  ): Promise<
    | {
        ok: true;
        content: string;
        exists: boolean;
        sha256: string;
        sizeBytes: number;
        reference: z.infer<typeof notificationCorrectionRefSchema> | null;
      }
    | ApiFailure
  > {
    let offset = 0;
    let value = '';
    let expectedHash: string | null = null;
    for (let index = 0; index < 1024; index += 1) {
      const query = new URLSearchParams({
        expected_revision: revision,
        variant,
        offset: String(offset),
        limit: '65536',
      });
      for (const [key, part] of Object.entries(target))
        if (part !== undefined) query.set(key, String(part));
      const result = await this.#readApi(
        context,
        `notification-workflows/${workflowId}/content?${query.toString()}`,
      );
      if (!result.ok) return result;
      const chunk = contentChunkSchema.parse(result.value);
      if (
        chunk.workflow_revision !== revision ||
        notificationLocationKey(chunk.target) !==
          notificationLocationKey(target) ||
        chunk.variant !== variant ||
        (expectedHash !== null && expectedHash !== chunk.content_sha256) ||
        (chunk.next_offset !== null && chunk.next_offset <= offset)
      )
        return apiFailure(
          'content_mismatch',
          '문서 내용의 저장 기준이 변경되었습니다. 다시 확인해 주세요.',
        );
      expectedHash = chunk.content_sha256;
      value += chunk.content;
      if (chunk.next_offset === null) {
        if (
          createHash('sha256').update(value).digest('hex') !==
            chunk.content_sha256 ||
          Buffer.byteLength(value, 'utf8') !== chunk.size_bytes
        )
          return apiFailure(
            'content_mismatch',
            '보관한 내용 전체를 확인하지 못했습니다.',
          );
        return {
          ok: true,
          content: value,
          exists: chunk.exists,
          sha256: chunk.content_sha256,
          sizeBytes: chunk.size_bytes,
          reference: chunk.correction_ref,
        };
      }
      offset = chunk.next_offset;
    }
    return apiFailure(
      'content_limit',
      '문서 내용 전체를 확인하지 못했습니다. 입력을 보존한 채 다시 확인해 주세요.',
    );
  }
}
