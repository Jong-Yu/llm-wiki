import { z } from 'zod';
import {
  knowledgeClaimSchema,
  knowledgeValueSchema,
} from '@contracts/knowledge.contract';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type {
  WorkspaceScope,
  WorkspaceRequest,
} from '@contracts/workspace.contract';

export type PersonalMode = 'conversations' | 'savedResults' | 'comparisons';
export type PersonalKind = 'conversations' | 'saved-results' | 'comparisons';
export type PersonalSession = WorkspaceScope & {
  connectionId: string;
  permissions: string[];
};
export type PersonalError = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
};
export type PersonalOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: PersonalError };
export type PersonalMutation = Extract<
  WorkspaceRequest,
  {
    operation:
      | 'createConversation'
      | 'appendTurn'
      | 'createSavedResult'
      | 'createComparison'
      | 'completeComparison';
  }
>;
export type ContextInput = Extract<
  WorkspaceRequest,
  { operation: 'questionContext' }
>['input'];
export type ClaimMapping = NonNullable<
  Extract<
    WorkspaceRequest,
    { operation: 'createComparison' }
  >['input']['mappings']
>[number];
export type ClaimSelection = NonNullable<
  Extract<
    WorkspaceRequest,
    { operation: 'completeComparison' }
  >['input']['reviewed_claims']
>[number];
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
export const personalRecordSchema = z
  .object({
    schema_version: z.literal(1),
    id,
    kind: z.enum(['conversations', 'saved-results', 'comparisons']),
    tenant: z.string(),
    user_id: z.string(),
    created_at: z.string(),
    actor: z.json(),
    data: knowledgeValueSchema,
    events: z.array(knowledgeValueSchema),
    requests: z.record(z.string(), z.string()),
  })
  .catchall(z.json());
export const recordEnvelopeSchema = z
  .object({ record: personalRecordSchema, revision })
  .catchall(z.json());
export type PersonalRecord = z.infer<typeof personalRecordSchema>;
export type RecordEnvelope = z.infer<typeof recordEnvelopeSchema>;
export const personalPageSchema = z
  .object({
    items: z.array(
      z.object({
        id,
        title: z.string(),
        created_at: z.string(),
        revision,
        kind: z.enum(['conversations', 'saved-results', 'comparisons']),
      }),
    ),
    next_cursor: z.string().nullable(),
    complete: z.boolean(),
    truncated: z.boolean(),
    skipped: z.array(z.json()),
  })
  .catchall(z.json());
export type PersonalPage = z.infer<typeof personalPageSchema>;
export const basisSchema = z
  .object({
    kind: z.literal('question_context'),
    originals: z
      .array(
        z
          .object({
            source_ref: z
              .object({
                source_id: id,
                source_version: id,
                source_sha256: revision,
              })
              .catchall(z.json()),
            content: z.string(),
            manifest: knowledgeValueSchema,
          })
          .catchall(z.json()),
      )
      .optional(),
    documents: z.array(
      z
        .object({
          document: z.string(),
          source_revision: revision,
          content: z.string(),
          knowledge: z
            .object({
              source_revision: revision,
              graph_revision: revision.nullable(),
              state_revision: revision,
              claims: z.array(knowledgeClaimSchema),
            })
            .catchall(z.json()),
        })
        .catchall(z.json()),
    ),
    scope: knowledgeValueSchema,
    can_prepare: z.boolean(),
    complete: z.boolean(),
    truncated: z.boolean(),
    skipped: z.array(z.json()),
    snapshot_revision: revision,
  })
  .catchall(z.json());
export type PersonalBasis = z.infer<typeof basisSchema>;
export type BasisDocument = PersonalBasis['documents'][number];
export type PendingReceipt = {
  kind: PersonalKind;
  requestId: string;
  recordId?: string;
};
export type PersonalWriteState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; message: string }
  | { status: 'blocked'; error: PersonalError; receipt?: PendingReceipt }
  | { status: 'error'; error: PersonalError };

/** 화면 이름을 실제 개인 저장소 종류로 매핑합니다. */
export function personalKind(mode: PersonalMode): PersonalKind {
  return mode === 'savedResults' ? 'saved-results' : mode;
}
/** 별도 쓰기 권한을 개인 기록 종류에 맞춰 확인합니다. */
export function writePermission(mode: PersonalMode): string {
  return mode === 'conversations'
    ? 'conversation_write'
    : mode === 'savedResults'
      ? 'result_write'
      : 'comparison_write';
}
/** 서버가 발급받은 요청 식별자를 폼 입력 없이 내부에서 생성합니다. */
export function newRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}
/** JSON 객체만 좁혀 스냅샷 원형을 유지합니다. */
export function objectValue(
  value: KnowledgeJson | undefined,
): KnowledgeValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}
/** 문자열이 아닌 필드를 빈 텍스트로 오인하지 않습니다. */
export function textValue(value: KnowledgeValue, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}
/** 기록에 포함된 전체 기준 스냅샷을 읽고 현재 데이터와 구분합니다. */
export function readBasis(
  value: KnowledgeJson | undefined,
): PersonalBasis | null {
  const result = basisSchema.safeParse(value);
  return result.success ? result.data : null;
}
/** 읽은 JSON의 알 수 없는 필드도 접힌 상세에 보존합니다. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
/** 선택한 주장 값의 주어·술어·목적어 또는 속성 내용을 사람이 읽을 수 있게 표시합니다. */
export function claimLabel(value: KnowledgeValue): string {
  const parts = [
    'subject',
    'predicate',
    'object',
    'entity',
    'property',
    'value',
    'unit',
  ].flatMap((key: string): string[] => {
    const field = value[key];
    if (
      typeof field === 'string' ||
      typeof field === 'number' ||
      typeof field === 'boolean'
    )
      return [String(field)];
    const nested = objectValue(field);
    return nested
      ? [
          textValue(nested, 'label') ||
            textValue(nested, 'quote') ||
            jsonText(nested),
        ]
      : [];
  });
  return parts.length > 0 ? parts.join(' · ') : jsonText(value);
}
/** 같은 명시 문서 집합을 비교 요청에 사용하며 저장 당시 필수 문서 선택도 보존합니다. */
export function contextForBasis(basis: PersonalBasis): ContextInput {
  const required = basis.scope.required_documents;
  return {
    documents: basis.documents.map(
      (item: BasisDocument): string => item.document,
    ),
    required_documents: Array.isArray(required)
      ? required.filter(
          (item: KnowledgeJson): item is string => typeof item === 'string',
        )
      : [],
  };
}
