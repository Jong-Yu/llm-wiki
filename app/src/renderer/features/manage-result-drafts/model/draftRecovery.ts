import { z } from 'zod';
import {
  draftDetailSchema,
  applicationSchema,
  emptyDraftState,
} from './resultDrafts';
import type { DraftState } from './resultDrafts';

const form = z.strictObject({
  title: z.string().max(200),
  content: z.string().max(1024 * 1024),
});
const recoveredSchema = z.object({
  selected: draftDetailSchema.nullable(),
  form,
  target: z
    .strictObject({
      document: z.string(),
      revision: z.string().nullable(),
      content: z.string(),
    })
    .nullable(),
  pending: z
    .strictObject({
      requestId: z.string().regex(/^[a-f0-9]{32}$/),
      operation: z.enum(['create', 'edit', 'apply']),
      draftId: z.string().optional(),
      document: z.string().optional(),
      revision: z.string().optional(),
    })
    .nullable(),
  applied: applicationSchema.nullable(),
  previousForm: form.nullable(),
});
/** 저장 당시 CAS·입력은 보존하고 사용자 확인과 최신 관측은 다시 요청합니다. */
export function decodeDraftRecovery(value: unknown): DraftState {
  return {
    ...emptyDraftState(),
    ...recoveredSchema.parse(value),
    message:
      '종료 전 입력을 복원했습니다. 서버 저장본과 기준을 다시 확인하세요.',
  };
}
/** 일시 오류·동의·검토 표시를 영구 승인으로 복원하지 않습니다. */
export function draftRecoveryValue(state: DraftState): DraftState {
  return decodeDraftRecovery(state);
}
