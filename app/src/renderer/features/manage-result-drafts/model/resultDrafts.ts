import { z } from 'zod';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import type {
  ResultDraftRequest,
  ResultDraftResult,
} from '@contracts/resultDrafts.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import { isDocumentPath } from '@contracts/documents.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export type DraftSession = WorkspaceScope & {
  connectionId: string;
  permissions: string[];
};
export type DraftError = Extract<ResultDraftResult, { ok: false }>['error'];
export type DraftOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: DraftError };
export type DraftCommand = {
  [K in ResultDraftRequest['operation']]: Omit<
    Extract<ResultDraftRequest, { operation: K }>,
    'connectionId' | 'expectedScope'
  >;
}[ResultDraftRequest['operation']];
export const draftFormSchema = z.object({
  title: z.string().trim().min(1, '제목을 입력해 주세요.').max(200),
  content: z.string().max(1024 * 1024, '초안 본문 한도를 초과했습니다.'),
});
export type DraftForm = z.infer<typeof draftFormSchema>;
export const targetFormSchema = z.object({
  document: z
    .string()
    .min(1)
    .max(4096)
    .refine(isDocumentPath, '상대 Markdown 경로를 입력해 주세요.'),
});
export const draftRecordSchema = z
  .object({
    revision,
    record: z
      .object({
        id,
        kind: z.literal('result-drafts'),
        tenant: z.string(),
        user_id: z.string(),
        data: z
          .object({
            title: z.string(),
            content: z.string(),
            original_generated_title: z.string(),
            original_generated_content: z.string(),
            source_result_id: id,
            source_result_revision: revision,
            basis: knowledgeValueSchema,
            answer_provenance: z.json().nullable(),
            origin: z.literal('client_reported'),
            human_approval: z.literal(false),
          })
          .catchall(z.json()),
        events: z.array(knowledgeValueSchema),
        requests: z.record(z.string(), revision),
      })
      .catchall(z.json()),
  })
  .catchall(z.json());
export const draftDetailSchema = draftRecordSchema.extend({
  draft: z.object({ title: z.string(), content: z.string() }),
  rendered_content: z.string(),
  rendered_size_bytes: z.number().int().min(0),
  can_apply_size: z.boolean(),
  basis_observation: z
    .object({
      status: z.enum(['current', 'changed', 'unavailable']),
      observation_revision: revision,
      documents: z.array(knowledgeValueSchema),
      originals: z.array(knowledgeValueSchema),
      profile_changed: z.boolean(),
    })
    .catchall(z.json()),
});
export type DraftDetail = z.infer<typeof draftDetailSchema>;
export const draftPageSchema = z.object({
  items: z.array(
    z.object({
      id,
      title: z.string(),
      created_at: z.string(),
      revision,
      kind: z.literal('result-drafts'),
    }),
  ),
  next_cursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.json()),
});
export type DraftPage = z.infer<typeof draftPageSchema>;
export const applicationSchema = z
  .object({
    record_id: id,
    request_id: id,
    state: z.enum(['complete', 'pending_reconcile', 'rejected']),
    saved: z.boolean().nullable(),
    receipt: z
      .object({
        document: z.string(),
        source_revision: revision,
        draft_id: id,
        draft_revision: revision,
        history_id: z.string().nullable(),
        changed: z.boolean(),
      })
      .catchall(z.json())
      .nullable(),
    cleanup_failures: z.array(z.json()),
    assurance: z.string().optional(),
  })
  .catchall(z.json());
export type DraftApplication = z.infer<typeof applicationSchema>;
export type DraftTarget = {
  document: string;
  revision: string | null;
  content: string;
};
export type DraftPending = {
  requestId: string;
  operation: 'create' | 'edit' | 'apply';
  draftId?: string;
  document?: string;
  revision?: string;
};
export type DraftState = {
  selected: DraftDetail | null;
  form: DraftForm;
  target: DraftTarget | null;
  inspection: DraftDetail | null;
  acknowledged: string | null;
  compared: boolean;
  pending: DraftPending | null;
  applied: DraftApplication | null;
  message: string;
  error: DraftError | null;
  conflict: boolean;
  previousForm: DraftForm | null;
};
/** 빈 표시 상태만 만들며 시안의 샘플 자료를 넣지 않습니다. */
export function emptyDraftState(): DraftState {
  return {
    selected: null,
    form: { title: '', content: '' },
    target: null,
    inspection: null,
    acknowledged: null,
    compared: false,
    pending: null,
    applied: null,
    message: '',
    error: null,
    conflict: false,
    previousForm: null,
  };
}
/** 관측값과 초안·대상 비교를 확인한 경우에만 명시 반영 버튼을 엽니다. */
export function canApplyDraft(
  state: DraftState,
  permissions: string[],
): boolean {
  const draft = state.selected;
  return (
    !!draft &&
    !!state.target &&
    state.compared &&
    !state.pending &&
    !state.conflict &&
    !state.applied?.saved &&
    permissions.includes('result_write') &&
    permissions.includes('write') &&
    draft.can_apply_size &&
    draft.rendered_size_bytes <= 1024 * 1024 &&
    draft.basis_observation.status !== 'unavailable' &&
    (draft.basis_observation.status === 'current' ||
      state.acknowledged === draft.basis_observation.observation_revision) &&
    state.form.title === draft.draft.title &&
    state.form.content === draft.draft.content
  );
}
/** 비밀 없는 요청 식별자만 만들며 쓰기 재시도에 새 ID를 자동 발급하지 않습니다. */
export function newDraftRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}
/** 현재 허용 범위 밖의 자료는 화면에 남기지 않되 메모리의 초안은 유지합니다. */
export function isDraftAccessError(error: DraftError): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    [
      'scope_changed',
      'unauthorized',
      'connection_required',
      'selection_required',
    ].includes(error.code)
  );
}
