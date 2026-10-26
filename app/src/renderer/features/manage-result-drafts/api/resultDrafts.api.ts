import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { resultDraftsGateway } from '@renderer/platform/resultDrafts';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { ResultDraftRequest } from '@contracts/resultDrafts.contract';
import {
  draftDetailSchema,
  draftPageSchema,
  draftRecordSchema,
  applicationSchema,
} from '../model/resultDrafts';
import type {
  DraftCommand,
  DraftSession,
  DraftOutcome,
  DraftDetail,
  DraftPage,
  DraftTarget,
  DraftPending,
  DraftApplication,
} from '../model/resultDrafts';

/** 현재 선택한 사용자·작업 공간·관점과 별도 결과 쓰기 권한을 읽습니다. */
export async function loadDraftSession(): Promise<DraftOutcome<DraftSession>> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok) return result;
    if (result.data.status !== 'connected' || !result.data.selection)
      return fail(
        'connection_required',
        '서버와 작업 공간을 먼저 선택해 주세요.',
      );
    const current = result.data;
    const selection = current.selection;
    if (!selection)
      return fail('selection_required', '작업 공간을 먼저 선택해 주세요.');
    const workspace = current.workspaces.find(
      (item: (typeof current.workspaces)[number]): boolean =>
        item.id === selection.tenant,
    );
    if (!workspace)
      return fail('scope_changed', '현재 허용 범위를 다시 확인해 주세요.');
    return {
      ok: true,
      data: {
        connectionId: current.connectionId,
        userId: current.userId,
        tenant: selection.tenant,
        profileId: selection.profile,
        policyRevision: current.policyRevision,
        permissions: workspace.permissions,
      },
    };
  } catch {
    return fail('unavailable', '현재 연결을 읽지 못했습니다.');
  }
}
/** 공개된 안전한 오류만 표시 상태로 보냅니다. */
export function fail<T>(code: string, message: string): DraftOutcome<T> {
  return { ok: false, error: { code, message } };
}
/** 연결 주체가 바뀐 늦은 응답은 현재 화면에 반영하지 않습니다. */
export function sameDraftScope(
  left: DraftSession,
  right: DraftSession,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    left.policyRevision === right.policyRevision
  );
}
/** 매번 편집 당시 범위를 검증하며 쓰기를 자동 재전송하지 않습니다. */
export async function requestDraft(
  session: DraftSession,
  command: DraftCommand,
): Promise<DraftOutcome<KnowledgeValue>> {
  const mutation = ['create', 'edit', 'apply'].includes(command.operation);
  try {
    const before = await loadDraftSession();
    if (!before.ok) return before;
    if (!sameDraftScope(session, before.data))
      return fail(
        'scope_changed',
        '현재 연결 범위가 변경되었습니다. 이전 초안을 보존했습니다.',
      );
    const request: ResultDraftRequest = {
      ...command,
      connectionId: session.connectionId,
      expectedScope: {
        userId: session.userId,
        tenant: session.tenant,
        profileId: session.profileId,
        policyRevision: session.policyRevision,
      },
    };
    const result = await resultDraftsGateway.execute(request);
    if (!result.ok) return result;
    const after = await loadDraftSession();
    if (
      !after.ok ||
      !sameDraftScope(session, after.data) ||
      result.data.operation !== command.operation ||
      result.data.connectionId !== session.connectionId ||
      result.data.access.userId !== session.userId ||
      result.data.access.tenant !== session.tenant ||
      result.data.access.profileId !== session.profileId ||
      result.data.access.policyRevision !== session.policyRevision
    )
      return fail(
        mutation ? 'outcome_unknown' : 'scope_changed',
        '응답 전에 허용 범위가 달라졌습니다. 원래 범위에서 동일 요청 영수증을 확인해 주세요.',
      );
    return { ok: true, data: result.data.data };
  } catch {
    return fail(
      mutation ? 'outcome_unknown' : 'unavailable',
      mutation
        ? '저장 응답을 확인하지 못했습니다. 동일 요청 영수증을 확인해 주세요.'
        : '초안 자료를 읽지 못했습니다.',
    );
  }
}
/** 목록의 불완전성·다음 페이지를 그대로 유지합니다. */
export async function listDrafts(
  session: DraftSession,
  cursor: string | null,
): Promise<DraftOutcome<DraftPage>> {
  const result = await requestDraft(session, {
    operation: 'list',
    input: { limit: 20, cursor },
  });
  if (!result.ok) return result;
  const parsed = draftPageSchema.safeParse(result.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : fail('invalid_response', '초안 목록을 확인하지 못했습니다.');
}
/** 저장 당시 전체 근거와 실제 소유자·선택 ID를 함께 확인합니다. */
export async function readDraft(
  session: DraftSession,
  draftId: string,
): Promise<DraftOutcome<DraftDetail>> {
  const result = await requestDraft(session, {
    operation: 'read',
    input: { draft_id: draftId },
  });
  if (!result.ok) return result;
  const parsed = draftDetailSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.record.id !== draftId ||
    parsed.data.record.user_id !== session.userId ||
    parsed.data.record.tenant !== session.tenant ||
    new TextEncoder().encode(parsed.data.rendered_content).byteLength !==
      parsed.data.rendered_size_bytes
  )
    return fail(
      'invalid_response',
      '초안과 전체 근거 응답을 확인하지 못했습니다.',
    );
  return { ok: true, data: parsed.data };
}
/** 실제 기록의 동일 요청 ID가 확인된 경우에만 초안 저장으로 표시합니다. */
export function confirmedDraftId(
  value: unknown,
  session: DraftSession,
  pending: DraftPending,
): string | null {
  const parsed = draftRecordSchema.safeParse(value);
  return parsed.success &&
    parsed.data.record.user_id === session.userId &&
    parsed.data.record.tenant === session.tenant &&
    (!pending.draftId || parsed.data.record.id === pending.draftId) &&
    !!parsed.data.record.requests[pending.requestId]
    ? parsed.data.record.id
    : null;
}
/** Wiki 반영 영수증의 대상·초안·요청·저장 판본이 일치하는지 확인합니다. */
export function confirmedApplication(
  value: unknown,
  pending: DraftPending,
): DraftApplication | null {
  const parsed = applicationSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.request_id !== pending.requestId ||
    parsed.data.record_id !== pending.draftId
  )
    return null;
  const receipt = parsed.data.receipt;
  if (
    parsed.data.saved &&
    (!receipt ||
      receipt.draft_id !== pending.draftId ||
      receipt.document !== pending.document ||
      receipt.draft_revision !== pending.revision)
  )
    return null;
  return parsed.data;
}
/** 404일 때만 신규 대상으로 인정하며 다른 실패를 빈 문서로 바꾸지 않습니다. */
export async function readDraftTarget(
  session: DraftSession,
  document: string,
): Promise<DraftOutcome<DraftTarget>> {
  const before = await loadDraftSession();
  if (!before.ok) return before;
  if (!sameDraftScope(session, before.data))
    return fail('scope_changed', '대상 조회 전에 연결 범위가 변경되었습니다.');
  try {
    const result = await documentsGateway.content({
      connectionId: session.connectionId,
      document,
    });
    const after = await loadDraftSession();
    if (!after.ok || !sameDraftScope(session, after.data))
      return fail('scope_changed', '대상 조회 중 연결 범위가 변경되었습니다.');
    if (!result.ok)
      return result.error.status === 404
        ? { ok: true, data: { document, revision: null, content: '' } }
        : result;
    const access = result.data.access;
    if (
      result.data.document !== document ||
      result.data.connectionId !== session.connectionId ||
      access.userId !== session.userId ||
      access.tenant !== session.tenant ||
      access.profileId !== session.profileId ||
      access.policyRevision !== session.policyRevision
    )
      return fail(
        'scope_changed',
        '대상 문서의 허용 범위를 확인하지 못했습니다.',
      );
    return {
      ok: true,
      data: {
        document,
        revision: result.data.revision,
        content: result.data.content,
      },
    };
  } catch {
    return fail('unavailable', '대상 문서를 읽지 못했습니다.');
  }
}
