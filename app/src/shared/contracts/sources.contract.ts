import { z } from 'zod';
import type { SourcePreviewRequest } from './documents.contract';
import {
  documentListPageSchema,
  MAX_SOURCE_BYTES,
  sourceItemSchema,
  sourceFormatSchema,
} from './documents.contract';

export const SOURCE_CHANNELS = {
  chooseFile: 'sources:choose-file',
  register: 'sources:register',
  receipt: 'sources:receipt',
  versions: 'sources:versions',
  download: 'sources:download',
} as const;
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const session = z.object({ connectionId: z.string().min(1).max(4096) });
export const sourceExpectedScopeSchema = z.strictObject({
  userId: z.string().min(1),
  tenant: z.string().min(1),
  profileId: z.string().min(1),
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
  accessRevision: z.string().min(1).optional(),
});
export type SourceExpectedScope = z.infer<typeof sourceExpectedScopeSchema>;
export const sourceSessionSchema = session.strict();
export const sourceReceiptRequestSchema = session
  .extend({ requestId: identifier })
  .strict();
export const sourceVersionsRequestSchema = session
  .extend({ sourceId: identifier })
  .strict();
const versionTarget = z
  .object({ sourceId: identifier, expectedRegistrationRevision: hash })
  .strict();
const title = z
  .string()
  .trim()
  .min(1, '제목을 입력해 주세요.')
  .max(200, '제목은 200자 이내로 입력해 주세요.')
  .refine(
    (value: string): boolean =>
      Array.from(value).every(
        (character: string): boolean => character.charCodeAt(0) >= 32,
      ),
    '제목에는 제어 문자를 사용할 수 없습니다.',
  );
const content = z
  .string()
  .max(MAX_SOURCE_BYTES)
  .refine(
    (value: string): boolean =>
      new TextEncoder().encode(value).byteLength <= MAX_SOURCE_BYTES,
    '원본은 UTF-8 20 MiB 이내여야 합니다.',
  );
export const sourceTextFieldsSchema = z.object({
  title,
  format: z.enum(['md', 'txt']),
  content,
});
export const sourceFileFieldsSchema = z.object({ title, fileId: identifier });
export const sourceRegistrationRequestSchema = z.discriminatedUnion('kind', [
  session
    .extend({
      kind: z.literal('text'),
      expectedScope: sourceExpectedScopeSchema.optional(),
      requestId: identifier,
      target: versionTarget.optional(),
      ...sourceTextFieldsSchema.shape,
    })
    .strict(),
  session
    .extend({
      kind: z.literal('file'),
      expectedScope: sourceExpectedScopeSchema.optional(),
      requestId: identifier,
      target: versionTarget.optional(),
      ...sourceFileFieldsSchema.shape,
    })
    .strict(),
]);
const error = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,128}$/),
  message: z.string().min(1).max(4096),
  status: z.number().int().min(100).max(599).optional(),
  traceId: identifier.optional(),
  requestId: identifier.optional(),
});
const failure = z.object({ ok: z.literal(false), error });
const file = z.object({
  fileId: identifier,
  filename: z.string().min(1).max(255),
  format: sourceFormatSchema,
  sizeBytes: z.number().int().min(0).max(MAX_SOURCE_BYTES),
});
const chosenFileResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: file.nullable() }),
  failure,
]);
const registrationBase = z.object({
  connectionId: z.string().min(1),
  requestId: identifier,
  cleanupWarningCount: z.number().int().min(0),
  access: documentListPageSchema.shape.access,
});
const registrationRecord = z.discriminatedUnion('state', [
  registrationBase.extend({
    state: z.literal('complete'),
    item: sourceItemSchema,
  }),
  registrationBase.extend({
    state: z.literal('pending_reconcile'),
    item: z.null(),
  }),
]);
const registrationResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: registrationRecord }),
  failure,
]);
const versionActorSchema = documentListPageSchema.shape.access;
const versionSchema = z.object({
  sourceVersion: identifier,
  sourceSha256: hash,
  sizeBytes: z.number().int().min(0).max(MAX_SOURCE_BYTES),
  kind: z.enum(['file', 'text']),
  format: sourceFormatSchema,
  filename: z.string().min(1).max(255).nullable(),
  title: z.string().min(1).max(200),
  createdAt: z.string().min(1).max(128),
  actor: versionActorSchema,
});
const versionsSchema = z.object({
  connectionId: z.string().min(1).max(4096),
  sourceId: identifier,
  title: z.string().min(1).max(200),
  currentVersion: identifier,
  registrationRevision: hash,
  versions: z.array(versionSchema).min(1).max(100),
  documents: z.array(z.record(z.string(), z.unknown())),
  access: documentListPageSchema.shape.access,
  traceId: identifier,
});
const versionsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: versionsSchema }),
  failure,
]);
const rawActorSchema = z.object({
  user_id: z.string().min(1),
  tenant: z.string().min(1),
  profile_id: z.string().min(1),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: hash,
  access_revision: z
    .string()
    .min(1)
    .nullish()
    .transform(
      (value: string | null | undefined): string | undefined =>
        value ?? undefined,
    ),
});
const rawVersionSchema = z.object({
  source_id: identifier,
  source_version: identifier,
  source_sha256: hash,
  size_bytes: z.number().int().min(0).max(MAX_SOURCE_BYTES),
  kind: z.enum(['file', 'text']),
  format: sourceFormatSchema,
  filename: z.string().min(1).max(255).nullable(),
  title: z.string().min(1).max(200),
  created_at: z.string().min(1).max(128),
  actor: rawActorSchema,
});
const rawVersionsSchema = z.object({
  data: z.object({
    source_id: identifier,
    title: z.string().min(1).max(200),
    current_version: identifier,
    registration_revision: hash,
    versions: z.array(rawVersionSchema).min(1).max(100),
    documents: z.array(z.record(z.string(), z.unknown())),
    access: rawActorSchema,
  }),
  meta: z.object({ trace_id: identifier }),
});

export type SourceSessionRequest = z.infer<typeof sourceSessionSchema>;
export type SourceReceiptRequest = z.infer<typeof sourceReceiptRequestSchema>;
export type SourceRegistrationRequest = z.infer<
  typeof sourceRegistrationRequestSchema
>;
export type SourceFile = z.infer<typeof file>;
export type ChooseSourceFileResult = z.infer<typeof chosenFileResult>;
export type SourceRegistrationRecord = z.infer<typeof registrationRecord>;
export type SourceRegistrationResult = z.infer<typeof registrationResult>;
export type SourceVersionsRequest = z.infer<typeof sourceVersionsRequestSchema>;
export type SourceVersion = z.infer<typeof versionSchema>;
export type SourceVersions = z.infer<typeof versionsSchema>;
export type SourceVersionsResult = z.infer<typeof versionsResultSchema>;
export type SourceDownloadRequest = SourcePreviewRequest;
const downloadResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.object({ saved: z.boolean() }) }),
  failure,
]);
export type SourceDownloadResult = z.infer<typeof downloadResultSchema>;
/** 다운로드는 저장 경로나 원본 바이트를 renderer에 되돌리지 않습니다. */
export function parseSourceDownloadResult(
  value: unknown,
): SourceDownloadResult {
  return downloadResultSchema.parse(value);
}
export type SourcesBridge = {
  download: (request: SourceDownloadRequest) => Promise<SourceDownloadResult>;
  chooseFile: (
    request: SourceSessionRequest,
  ) => Promise<ChooseSourceFileResult>;
  register: (
    request: SourceRegistrationRequest,
  ) => Promise<SourceRegistrationResult>;
  receipt: (request: SourceReceiptRequest) => Promise<SourceRegistrationResult>;
  versions: (request: SourceVersionsRequest) => Promise<SourceVersionsResult>;
};

/** main과 preload는 원본 경로/자격 증명을 공개 계약 밖으로 전달하지 않습니다. */
export function parseChooseSourceFileResult(
  value: unknown,
): ChooseSourceFileResult {
  return chosenFileResult.parse(value);
}

/** 등록 완료·조정 대기·실패를 구분하고 검증된 공개 영수증만 전달합니다. */
export function parseSourceRegistrationResult(
  value: unknown,
): SourceRegistrationResult {
  return registrationResult.parse(value);
}

/** 전체 보존된 원본 판본을 명시적으로 옮기고 과거 판본의 주체/시각도 유지합니다. */
export function parseSourceVersionsResponse(
  value: unknown,
  connectionId: string,
): SourceVersions {
  const { data, meta } = rawVersionsSchema.parse(value);
  if (
    data.versions.at(-1)?.source_version !== data.current_version ||
    new Set(
      data.versions.map(
        (version: z.infer<typeof rawVersionSchema>): string =>
          version.source_version,
      ),
    ).size !== data.versions.length ||
    data.versions.some(
      (version: z.infer<typeof rawVersionSchema>): boolean =>
        version.source_id !== data.source_id ||
        version.actor.tenant !== data.access.tenant,
    )
  )
    throw new Error('invalid_versions');
  return {
    connectionId,
    sourceId: data.source_id,
    title: data.title,
    currentVersion: data.current_version,
    registrationRevision: data.registration_revision,
    versions: data.versions.map(
      (version: z.infer<typeof rawVersionSchema>): SourceVersion => ({
        sourceVersion: version.source_version,
        sourceSha256: version.source_sha256,
        sizeBytes: version.size_bytes,
        kind: version.kind,
        format: version.format,
        filename: version.filename,
        title: version.title,
        createdAt: version.created_at,
        actor: publicVersionActor(version.actor),
      }),
    ),
    documents: data.documents,
    access: publicVersionActor(data.access),
    traceId: meta.trace_id,
  };
}

/** 서버가 확인한 주체만 공개하며 임의 actor나 비밀 필드를 추가하지 않습니다. */
function publicVersionActor(
  actor: z.infer<typeof rawActorSchema>,
): SourceVersions['access'] {
  return {
    userId: actor.user_id,
    tenant: actor.tenant,
    profileId: actor.profile_id,
    domain: actor.domain,
    viewpoint: actor.viewpoint,
    policyRevision: actor.policy_revision,
    ...(actor.access_revision ? { accessRevision: actor.access_revision } : {}),
  };
}

/** IPC의 원본 판본 결과도 공개 계약만 유지합니다. */
export function parseSourceVersionsResult(
  value: unknown,
): SourceVersionsResult {
  return versionsResultSchema.parse(value);
}
