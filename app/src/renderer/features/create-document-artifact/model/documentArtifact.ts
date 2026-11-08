import { sameAccessRevision } from '@contracts/connection.contract';
import { z } from 'zod';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import type { ResultDraftRequest } from '@contracts/resultDrafts.contract';
import type { QuestionDetail } from '@contracts/questionRuns.contract';

export type ArtifactGenerationStatus =
  | 'none'
  | 'unconfirmed'
  | 'failed'
  | 'running'
  | 'unsaved';

/** 미확인 영수증을 실패보다 우선하며 실제 저장 또는 답변이 있으면 생성 실패로 표시하지 않습니다. */
export function artifactGenerationStatus(
  generation: QuestionDetail | null,
): ArtifactGenerationStatus {
  if (!generation) return 'none';
  const confirmedRequest = generation.receipts.some(
    (receipt: QuestionDetail['receipts'][number]): boolean =>
      receipt.request_id === generation.local.requestId &&
      receipt.saved !== null,
  );
  const unknownReceipt = generation.receipts.some(
    (receipt: QuestionDetail['receipts'][number]): boolean =>
      receipt.saved === null,
  );
  if (
    (generation.local.requestId !== null && !confirmedRequest) ||
    unknownReceipt
  )
    return 'unconfirmed';
  const saved = generation.receipts.some(
    (receipt: QuestionDetail['receipts'][number]): boolean =>
      receipt.saved === true,
  );
  if (
    !saved &&
    generation.answers.length === 0 &&
    (['failed', 'cancelled'].includes(generation.status) ||
      generation.local.status === 'failed')
  )
    return 'failed';
  if (['queued', 'running'].includes(generation.status)) return 'running';
  return 'unsaved';
}

export const artifactIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export type ArtifactSession = WorkspaceScope & {
  connectionId: string;
  permissions: string[];
};
export type ArtifactError = { code: string; message: string; status?: number };
export type ArtifactOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: ArtifactError };
export type DraftCommand = {
  [K in ResultDraftRequest['operation']]: Omit<
    Extract<ResultDraftRequest, { operation: K }>,
    'connectionId' | 'expectedScope'
  >;
}[ResultDraftRequest['operation']];
export const artifactFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '제목을 입력해 주세요.')
    .max(200, '제목은 200자 이내로 입력해 주세요.'),
  content: z
    .string()
    .refine(
      (value: string): boolean =>
        new TextEncoder().encode(value).byteLength <= 1024 * 1024,
      '본문은 UTF-8 1 MiB 이내로 입력해 주세요.',
    ),
});
export type ArtifactForm = z.infer<typeof artifactFormSchema>;
const record = z.object({
  id: artifactIdSchema,
  tenant: z.string(),
  user_id: z.string(),
  created_at: z.string(),
  requests: z.record(z.string(), z.string()),
});
export const savedArtifactSchema = z.object({
  revision,
  record: record.extend({
    kind: z.literal('saved-results'),
    data: z.object({
      title: z.string(),
      content: z.string(),
      basis: z.unknown(),
      conversation_id: artifactIdSchema.nullable().optional(),
      answer_provenance: z.unknown(),
    }),
  }),
});
export type SavedArtifact = z.infer<typeof savedArtifactSchema>;
export const artifactDraftRecordSchema = z.object({
  revision,
  record: record.extend({
    kind: z.literal('result-drafts'),
    data: z.object({
      source_result_id: artifactIdSchema,
      source_result_revision: revision,
    }),
  }),
});
export const artifactDraftSchema = artifactDraftRecordSchema.extend({
  draft: z.object({ title: z.string(), content: z.string() }),
});
export type ArtifactDraft = z.infer<typeof artifactDraftSchema>;
export const artifactRecoverySchema = z.object({
  artifactId: artifactIdSchema,
  form: z.object({ title: z.string(), content: z.string() }),
  draft: artifactDraftSchema.nullable(),
  conflicted: z.boolean().default(false),
  previousForm: z
    .object({ title: z.string(), content: z.string() })
    .nullable()
    .default(null),
  pending: z
    .object({
      requestId: artifactIdSchema,
      operation: z.enum(['create', 'edit']),
      draftId: artifactIdSchema.nullable(),
    })
    .nullable(),
});
export type ArtifactRecovery = z.infer<typeof artifactRecoverySchema>;
export type ArtifactEvidence = { document: string; revision: string | null };

/** 고정 근거에 실제로 있는 문서 참조만 표시하며 새 인용을 만들지 않습니다. */
export function artifactEvidence(value: unknown): ArtifactEvidence[] {
  const basis = z
    .object({
      documents: z.array(
        z.object({
          document: z.string(),
          source_revision: revision.optional(),
        }),
      ),
    })
    .safeParse(value);
  if (!basis.success) return [];
  return basis.data.documents.map(
    (item: (typeof basis.data.documents)[number]): ArtifactEvidence => ({
      document: item.document,
      revision: item.source_revision ?? null,
    }),
  );
}

/** 범위 변경 시 이전 개인 자료를 다른 작업 공간에 표시하지 않습니다. */
export function sameArtifactScope(
  left: ArtifactSession,
  right: ArtifactSession,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    sameAccessRevision(left, right)
  );
}

/** 접근 오류만 본문을 숨기며 일반 저장 실패에는 입력을 유지합니다. */
export function isArtifactAccessError(error: ArtifactError): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    ['scope_changed', 'connection_required', 'unauthorized'].includes(
      error.code,
    )
  );
}
