import { z } from 'zod';

export const DOCUMENT_CHANNELS: {
  readonly list: 'documents:list';
  readonly content: 'documents:content';
  readonly sourcePreview: 'documents:source-preview';
} = {
  list: 'documents:list',
  content: 'documents:content',
  sourcePreview: 'documents:source-preview',
};

const textSchema = z.string().min(1).max(4096);
const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** 저장소와 같은 상대 Markdown 경로만 허용하고 경로 정규화로 다른 문서를 선택하지 않습니다. */
export function isDocumentPath(document: string): boolean {
  return (
    document.endsWith('.md') &&
    !document.includes('\\') &&
    !document.includes('\0') &&
    !/^[a-z]:/i.test(document) &&
    document
      .split('/')
      .every(
        (part: string): boolean => part !== '' && part !== '.' && part !== '..',
      )
  );
}
const documentPathSchema = textSchema.refine(isDocumentPath);
const contentBodySchema = z
  .string()
  .max(MAX_DOCUMENT_BYTES)
  .refine(
    (content: string): boolean =>
      new TextEncoder().encode(content).byteLength <= MAX_DOCUMENT_BYTES,
  );
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const traceSchema = z.string().regex(/^[a-f0-9]{32}$/);
const errorSchema = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .max(128),
  message: textSchema,
  status: z.number().int().min(100).max(599).optional(),
  traceId: traceSchema.optional(),
});
const documentMetadataSchema = z.record(z.string(), z.json());
const authorshipSchema = z.object({
  status: z.string(),
  created: z.record(z.string(), z.json()).nullable(),
  updated: z.record(z.string(), z.json()).nullable(),
});
const documentExtras = {
  metadata: documentMetadataSchema.optional(),
  bodyRevision: textSchema.optional(),
  documentId: z.string().nullable().optional(),
  authorship: authorshipSchema.optional(),
};
const rawDocumentExtras = {
  metadata: documentMetadataSchema.optional(),
  body_revision: textSchema.optional(),
  document_id: z.string().nullable().optional(),
  authorship: authorshipSchema.optional(),
};
const wikiItemSchema = z.object({
  kind: z.literal('wiki'),
  ...documentExtras,
  document: textSchema,
  revision: textSchema,
  sourceStatus: z.enum(['unlinked', 'linked', 'unknown']),
});
export const sourceFormatSchema = z.enum([
  'md',
  'txt',
  'pdf',
  'xlsx',
  'docx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
]);
export type SourceFormat = z.infer<typeof sourceFormatSchema>;
export const sourceItemSchema = z.object({
  kind: z.literal('source'),
  sourceId: textSchema,
  title: textSchema,
  sourceVersion: textSchema,
  sourceSha256: textSchema,
  sizeBytes: countSchema,
  format: sourceFormatSchema,
  registrationRevision: textSchema,
  linkedDocumentCount: countSchema,
  analysisStatus: z.literal('not_started'),
});
const accessSchema = z.object({
  userId: textSchema,
  tenant: textSchema,
  profileId: textSchema,
  domain: z.string().max(4096).nullable(),
  viewpoint: z.string().max(4096).nullable(),
  policyRevision: textSchema,
  accessRevision: z.string().min(1).optional(),
});
const scopeSchema = z.object({
  tenant: textSchema,
  kind: z.enum(['wiki_documents', 'source_documents']),
});
const skippedSchema = z.object({
  document: z.string().max(4096),
  code: textSchema,
});

export const documentListRequestSchema = z.strictObject({
  connectionId: textSchema,
  cursor: z.string().min(1).max(16384).nullable(),
  limit: z.number().int().min(1).max(50),
});
export const documentListPageSchema = z.object({
  connectionId: textSchema,
  items: z.array(z.union([wikiItemSchema, sourceItemSchema])),
  scope: scopeSchema,
  access: accessSchema,
  catalogRevision: textSchema,
  nextCursor: z.string().min(1).max(16384).nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(skippedSchema),
  scanned: countSchema,
  requiresRefresh: z.boolean(),
  traceId: traceSchema,
});
const documentListResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: documentListPageSchema }),
  z.object({ ok: z.literal(false), error: errorSchema }),
]);
export const documentContentRequestSchema = z.strictObject({
  connectionId: textSchema,
  document: documentPathSchema,
});
export const documentContentSchema = z.object({
  ...documentExtras,
  body: contentBodySchema.optional(),
  bodyStartLine: z.number().int().min(1).optional(),
  connectionId: textSchema,
  document: documentPathSchema,
  content: contentBodySchema,
  revision: textSchema,
  access: accessSchema,
  traceId: traceSchema,
});
const documentContentResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: documentContentSchema }),
  z.object({ ok: z.literal(false), error: errorSchema }),
]);
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const sourceIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceReferenceSchema = z.object({
  sourceId: sourceIdSchema,
  sourceVersion: sourceIdSchema,
  sourceSha256: sourceHashSchema,
  sizeBytes: countSchema.max(MAX_SOURCE_BYTES),
  format: sourceFormatSchema,
});
const sourcePreviewRequestSchema = sourceReferenceSchema
  .safeExtend({
    connectionId: textSchema,
  })
  .strict();
const sourcePreviewBase = sourceReferenceSchema.extend({
  connectionId: textSchema,
  access: accessSchema,
  traceId: traceSchema,
});
// 바이너리 원문과 로컬 경로는 전달하지 않으며 미변환 상태를 실제 빈 텍스트와 구분합니다.
const sourcePreviewSchema = z.discriminatedUnion('previewStatus', [
  sourcePreviewBase.extend({
    previewStatus: z.literal('text'),
    format: z.enum(['md', 'txt']),
    content: z.string().max(MAX_SOURCE_BYTES),
  }),
  sourcePreviewBase.extend({
    previewStatus: z.literal('conversion_required'),
    format: sourceFormatSchema.exclude(['md', 'txt']),
    content: z.null(),
  }),
]);
const sourcePreviewResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: sourcePreviewSchema }),
  z.object({ ok: z.literal(false), error: errorSchema }),
]);
export type SourcePreviewRequest = z.infer<typeof sourcePreviewRequestSchema>;
export type SourcePreview = z.infer<typeof sourcePreviewSchema>;
export type SourcePreviewResult = z.infer<typeof sourcePreviewResultSchema>;

export type DocumentListRequest = z.infer<typeof documentListRequestSchema>;
export type DocumentListItem =
  | z.infer<typeof wikiItemSchema>
  | z.infer<typeof sourceItemSchema>;
export type DocumentListPage = z.infer<typeof documentListPageSchema>;
export type DocumentListResult = z.infer<typeof documentListResultSchema>;
export type DocumentContentRequest = z.infer<
  typeof documentContentRequestSchema
>;
export type DocumentContent = z.infer<typeof documentContentSchema>;
export type DocumentContentResult = z.infer<typeof documentContentResultSchema>;
export type DocumentsBridge = {
  list: (request: DocumentListRequest) => Promise<DocumentListResult>;
  content: (request: DocumentContentRequest) => Promise<DocumentContentResult>;
  sourcePreview: (
    request: SourcePreviewRequest,
  ) => Promise<SourcePreviewResult>;
};

const rawWikiSchema = z.strictObject({
  ...rawDocumentExtras,
  document: textSchema,
  revision: textSchema,
  source_status: z.enum(['unlinked', 'linked', 'unknown']),
});
const rawSourceSchema = z.strictObject({
  kind: z.literal('source'),
  source_id: textSchema,
  title: textSchema,
  source_version: textSchema,
  source_sha256: textSchema,
  size_bytes: countSchema,
  format: sourceFormatSchema,
  registration_revision: textSchema,
  documents: z.array(z.record(z.string(), z.unknown())),
  analysis_status: z.literal('not_started'),
});
const rawAccessSchema = z.strictObject({
  user_id: textSchema,
  tenant: textSchema,
  profile_id: textSchema,
  domain: z.string().max(4096).nullable(),
  viewpoint: z.string().max(4096).nullable(),
  policy_revision: textSchema,
  access_revision: z
    .string()
    .min(1)
    .nullish()
    .transform(
      (value: string | null | undefined): string | undefined =>
        value ?? undefined,
    ),
});
const sourceCatalogEnvelopeSchema = z.object({
  data: z.object({
    source_id: sourceIdSchema,
    versions: z.array(
      z.object({
        source_version: sourceIdSchema,
        source_sha256: sourceHashSchema,
        size_bytes: countSchema.max(MAX_SOURCE_BYTES),
        format: sourceFormatSchema,
      }),
    ),
    access: rawAccessSchema,
  }),
  meta: z.object({ trace_id: traceSchema }),
});
const rawPageSchema = z.strictObject({
  items: z.array(z.union([rawWikiSchema, rawSourceSchema])),
  scope: scopeSchema,
  catalog_revision: textSchema,
  next_cursor: z.string().min(1).max(16384).nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(skippedSchema),
  scanned: countSchema,
  requires_refresh: z.boolean(),
  access: rawAccessSchema,
});
const envelopeSchema = z.strictObject({
  data: rawPageSchema,
  meta: z.strictObject({ trace_id: traceSchema }),
});
const contentEnvelopeSchema = z.strictObject({
  data: z.strictObject({
    ...rawDocumentExtras,
    body: z.string().optional(),
    body_start_line: z.number().int().min(1).optional(),
    document: documentPathSchema,
    content: z.string(),
    revision: textSchema,
    access: rawAccessSchema,
  }),
  meta: z.strictObject({ trace_id: traceSchema }),
});
type RawItem = z.infer<typeof rawWikiSchema> | z.infer<typeof rawSourceSchema>;

/** caller가 서버 주소/tenant/profile을 지정하지 못하도록 목록 입력을 제한합니다. */
export function parseDocumentListRequest(value: unknown): DocumentListRequest {
  const parsed = documentListRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error('문서 목록 요청을 확인해 주세요.');
  return parsed.data;
}

/** 서버 목록을 명시적으로 매핑하고 원본의 문서 연결은 개수만 공개합니다. */
export function parseDocumentListResponse(
  value: unknown,
  connectionId: string,
): DocumentListPage {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('문서 목록 응답 형식을 확인할 수 없습니다.');
  const { data, meta } = parsed.data;
  return {
    connectionId,
    items: data.items.map((item: RawItem): DocumentListItem =>
      'kind' in item
        ? {
            kind: 'source',
            sourceId: item.source_id,
            title: item.title,
            sourceVersion: item.source_version,
            sourceSha256: item.source_sha256,
            sizeBytes: item.size_bytes,
            format: item.format,
            registrationRevision: item.registration_revision,
            linkedDocumentCount: item.documents.length,
            analysisStatus: item.analysis_status,
          }
        : {
            kind: 'wiki',
            metadata: item.metadata,
            bodyRevision: item.body_revision,
            documentId: item.document_id,
            authorship: item.authorship,
            document: item.document,
            revision: item.revision,
            sourceStatus: item.source_status,
          },
    ),
    scope: data.scope,
    access: {
      userId: data.access.user_id,
      tenant: data.access.tenant,
      profileId: data.access.profile_id,
      domain: data.access.domain,
      viewpoint: data.access.viewpoint,
      policyRevision: data.access.policy_revision,
      ...(data.access.access_revision
        ? { accessRevision: data.access.access_revision }
        : {}),
    },
    catalogRevision: data.catalog_revision,
    nextCursor: data.next_cursor,
    complete: data.complete,
    truncated: data.truncated,
    skipped: data.skipped,
    scanned: data.scanned,
    requiresRefresh: data.requires_refresh,
    traceId: meta.trace_id,
  };
}

/** IPC 응답을 검사해 공개 목록 계약에 없는 필드를 renderer에 넘기지 않습니다. */
export function parseDocumentListResult(value: unknown): DocumentListResult {
  const parsed = documentListResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('문서 목록 결과를 확인할 수 없습니다.');
  return parsed.data;
}

/** 본문 요청에는 현재 연결과 상대 문서 경로만 허용합니다. */
export function parseDocumentContentRequest(
  value: unknown,
): DocumentContentRequest {
  const parsed = documentContentRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error('문서 본문 요청을 확인해 주세요.');
  return parsed.data;
}

/** 원문의 빈 문자열·공백·개행과 실제 revision을 보존하며 서버 응답을 매핑합니다. */
export function parseDocumentContentResponse(
  value: unknown,
  connectionId: string,
): DocumentContent {
  const parsed = contentEnvelopeSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('문서 본문 응답 형식을 확인할 수 없습니다.');
  const { data, meta } = parsed.data;
  if (!contentBodySchema.safeParse(data.content).success)
    throw new Error('document_too_large');
  return {
    connectionId,
    document: data.document,
    content: data.content,
    metadata: data.metadata,
    body: data.body,
    bodyStartLine: data.body_start_line,
    bodyRevision: data.body_revision,
    documentId: data.document_id,
    authorship: data.authorship,
    revision: data.revision,
    access: {
      userId: data.access.user_id,
      tenant: data.access.tenant,
      profileId: data.access.profile_id,
      domain: data.access.domain,
      viewpoint: data.access.viewpoint,
      policyRevision: data.access.policy_revision,
      ...(data.access.access_revision
        ? { accessRevision: data.access.access_revision }
        : {}),
    },
    traceId: meta.trace_id,
  };
}

/** IPC 본문 결과를 재검사하고 공개 계약에 없는 필드를 제거합니다. */
export function parseDocumentContentResult(
  value: unknown,
): DocumentContentResult {
  const parsed = documentContentResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('문서 본문 결과를 확인할 수 없습니다.');
  return parsed.data;
}

/** 원본은 서버 발급 식별자와 목록에서 확인한 불변 판본만 요청합니다. */
export function parseSourcePreviewRequest(
  value: unknown,
): SourcePreviewRequest {
  const parsed = sourcePreviewRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error('원본 미리보기 요청을 확인해 주세요.');
  return parsed.data;
}

/** 카탈로그에 선택 판본과 동일한 hash/크기/형식이 보존돼 있는지 대조합니다. */
export function parseSourceCatalog(
  value: unknown,
  request: SourcePreviewRequest,
): { access: SourcePreview['access']; traceId: string } {
  const { data, meta } = sourceCatalogEnvelopeSchema.parse(value);
  const version = data.versions.find(
    (
      item: z.infer<
        typeof sourceCatalogEnvelopeSchema
      >['data']['versions'][number],
    ): boolean => item.source_version === request.sourceVersion,
  );
  if (
    data.source_id !== request.sourceId ||
    !version ||
    version.source_sha256 !== request.sourceSha256 ||
    version.size_bytes !== request.sizeBytes ||
    version.format !== request.format
  )
    throw new Error('source_mismatch');
  return {
    access: {
      userId: data.access.user_id,
      tenant: data.access.tenant,
      profileId: data.access.profile_id,
      domain: data.access.domain,
      viewpoint: data.access.viewpoint,
      policyRevision: data.access.policy_revision,
      ...(data.access.access_revision
        ? { accessRevision: data.access.access_revision }
        : {}),
    },
    traceId: meta.trace_id,
  };
}

/** 원본 IPC 결과는 공개 계약만 전달하며 원문의 공백/개행을 유지합니다. */
export function parseSourcePreviewResult(value: unknown): SourcePreviewResult {
  const parsed = sourcePreviewResultSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('원본 미리보기 결과를 확인할 수 없습니다.');
  return parsed.data;
}
