import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';
import { knowledgeValueSchema } from './knowledge.contract';
import { documentListPageSchema } from './documents.contract';

export const ARTIFACTS_CHANNELS = {
  chooseFile: 'artifacts:choose-file',
  upload: 'artifacts:upload',
  download: 'artifacts:download',
} as const;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const sizeBytes = z
  .number()
  .int()
  .min(0)
  .max(20 * 1024 * 1024);
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value: string): boolean =>
      !/[\\/:]/.test(value) &&
      value !== '.' &&
      value !== '..' &&
      !Array.from(value).some(
        (character: string): boolean =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
const scope = {
  connectionId: z.string().min(1).max(4096),
  expectedScope: workspaceScopeSchema,
};
export const chooseArtifactFileRequestSchema = z.strictObject(scope);
export const artifactUploadRequestSchema = z.strictObject({
  ...scope,
  fileId: id,
  requestId: id,
  jobId: id,
  runId: id,
  expectedJobRevision: revision,
  bundleId: id,
  bundleRevision: revision,
  extractionId: id,
  extractionRevision: revision,
  contentSha256: revision,
});
export const artifactDownloadRequestSchema = z.strictObject({
  ...scope,
  jobId: id,
  extractionId: id,
  artifactId: id,
  expectedSha256: revision,
  sizeBytes,
  filename,
});
export const artifactFileSchema = z.strictObject({
  fileId: id,
  filename,
  sizeBytes,
  sha256: revision,
});
const saved = z.strictObject({ filename, sizeBytes, sha256: revision });
const error = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,128}$/),
  message: z.string().min(1).max(4096),
  status: z.number().int().min(100).max(599).optional(),
  traceId: id.optional(),
  retry: z.enum(['none', 'read_again', 'same_basis', 'reconcile']).optional(),
});
const fileResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: artifactFileSchema }),
  z.object({ ok: z.literal(false), error }),
]);
const savedResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: saved }),
  z.object({ ok: z.literal(false), error }),
]);
export type ChooseArtifactFileRequest = z.infer<
  typeof chooseArtifactFileRequestSchema
>;
export type ArtifactUploadRequest = z.infer<typeof artifactUploadRequestSchema>;
export type ArtifactDownloadRequest = z.infer<
  typeof artifactDownloadRequestSchema
>;
export type ArtifactFile = z.infer<typeof artifactFileSchema>;
export type ChooseArtifactFileResult = z.infer<typeof fileResult>;
export type ArtifactDownloadResult = z.infer<typeof savedResult>;
const uploadResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      connectionId: scope.connectionId,
      data: knowledgeValueSchema,
      access: documentListPageSchema.shape.access,
      traceId: id,
    }),
  }),
  z.object({ ok: z.literal(false), error }),
]);
export type ArtifactUploadResult = z.infer<typeof uploadResult>;
export type ArtifactsBridge = {
  chooseFile: (
    request: ChooseArtifactFileRequest,
  ) => Promise<ChooseArtifactFileResult>;
  upload: (request: ArtifactUploadRequest) => Promise<ArtifactUploadResult>;
  download: (
    request: ArtifactDownloadRequest,
  ) => Promise<ArtifactDownloadResult>;
};
/** 바이너리·경로 없이 main이 발급한 선택 정보만 검사합니다. */
export function parseChooseArtifactFileResult(
  value: unknown,
): ChooseArtifactFileResult {
  return fileResult.parse(value);
}
/** 새 파일의 실제 저장 정보만 renderer에 전달합니다. */
export function parseArtifactDownloadResult(
  value: unknown,
): ArtifactDownloadResult {
  return savedResult.parse(value);
}
/** 업로드 결과도 전체 업무 JSON과 확인된 접근 범위를 유지합니다. */
export function parseArtifactUploadResult(
  value: unknown,
): ArtifactUploadResult {
  return uploadResult.parse(value);
}
