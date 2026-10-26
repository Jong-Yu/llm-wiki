import { connectionGateway } from '@renderer/platform/connection';
import { workspaceGateway } from '@renderer/platform/workspace';
import { documentsGateway } from '@renderer/platform/documents';
import { workspaceRequestSchema } from '@contracts/workspace.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import type { ConnectionResult } from '@contracts/connection.contract';
import type { DocumentContent } from '@contracts/documents.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import {
  detailSchema,
  findSchema,
  preparedSchema,
  receiptSchema,
  dependenciesUnchanged,
  canonical,
} from '../model/correspondence.schema';
import type {
  Scope,
  Outcome,
  Detail,
  Found,
  Intent,
  Prepared,
  QueryContext,
} from '../model/correspondence.schema';

/** 같은 연결 안의 관점·정책 변경도 이전 근거를 무효화합니다. */
function matches(result: ConnectionResult, scope: Scope): boolean {
  return (
    result.ok &&
    result.data.status === 'connected' &&
    result.data.connectionId === scope.connectionId &&
    result.data.userId === scope.userId &&
    result.data.policyRevision === scope.policyRevision &&
    result.data.selection?.tenant === scope.tenant &&
    result.data.selection.profile === scope.profileId
  );
}
/** 공개 범위만 화면에 제공하고 토큰·주소는 main에 유지합니다. */
export async function loadScope(): Promise<Outcome<Scope>> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok) return result;
    if (result.data.status !== 'connected' || !result.data.selection)
      return failure(
        'connection_required',
        '서버와 작업 공간을 먼저 선택해 주세요.',
      );
    const current = result.data;
    const selection = current.selection;
    if (!selection)
      return failure('connection_required', '작업 공간을 선택해 주세요.');
    const membership = current.workspaces.find(
      (item: (typeof current.workspaces)[number]): boolean =>
        item.id === selection.tenant,
    );
    if (!membership?.permissions.includes('read'))
      return failure('forbidden', '현재 범위의 읽기 권한이 없습니다.');
    return {
      ok: true,
      data: {
        connectionId: current.connectionId,
        userId: current.userId,
        tenant: selection.tenant,
        profileId: selection.profile,
        policyRevision: current.policyRevision,
        permissions: membership.permissions,
      },
    };
  } catch {
    return failure('bridge_unavailable', '현재 연결을 확인할 수 없습니다.');
  }
}
/** 실패와 쓰기 결과 미확인을 구분합니다. */
export function failure<T>(code: string, message: string): Outcome<T> {
  return { ok: false, error: { code, message } };
}
/** 모든 응답의 현재 범위와 작업 종류를 확인합니다. */
async function request(
  scope: Scope,
  command: WorkspaceRequest,
  mutation: boolean = false,
): Promise<Outcome<KnowledgeValue>> {
  try {
    if (!matches(await connectionGateway.getState(), scope))
      return failure(
        'scope_changed',
        '작업 공간·관점이 변경되었습니다. 다시 연결해 주세요.',
      );
    const result = await workspaceGateway.execute({
      ...command,
      expectedScope: {
        userId: scope.userId,
        tenant: scope.tenant,
        profileId: scope.profileId,
        policyRevision: scope.policyRevision,
      },
    });
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      !matches(await connectionGateway.getState(), scope) ||
      result.data.connectionId !== scope.connectionId ||
      result.data.operation !== command.operation ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision
    )
      return failure(
        'scope_changed',
        '변경된 연결에서 이전 응답을 표시하지 않습니다.',
      );
    return { ok: true, data: result.data.data };
  } catch {
    return failure(
      mutation ? 'outcome_unknown' : 'bridge_unavailable',
      mutation
        ? '저장 응답을 확인하지 못했습니다. 이력을 조회해 대조해 주세요.'
        : '조회 응답을 확인할 수 없습니다.',
    );
  }
}
/** 명시한 문서 안의 기존 대응만 조회합니다. */
export async function findCorrespondences(
  scope: Scope,
  documents: string[],
  text: string,
  context: QueryContext,
): Promise<Outcome<Found>> {
  const result = await request(scope, {
    connectionId: scope.connectionId,
    operation: 'correspondenceFind',
    input: { documents, text: text || null, limit: 50, ...context },
  });
  if (!result.ok) return result;
  const parsed = findSchema.safeParse(result.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : failure('invalid_response', '대응 목록을 확인할 수 없습니다.');
}
/** 대응 하나의 현재 판단과 전체 이력을 읽습니다. */
export async function readCorrespondence(
  scope: Scope,
  id: string,
  context: QueryContext = { application_context: {}, as_of: null },
): Promise<Outcome<Detail>> {
  const result = await request(scope, {
    connectionId: scope.connectionId,
    operation: 'correspondenceQuery',
    input: { correspondence_id: id, ...context },
  });
  if (!result.ok) return result;
  const parsed = detailSchema.safeParse(result.data);
  return parsed.success && parsed.data.correspondence_id === id
    ? { ok: true, data: parsed.data }
    : failure('invalid_response', '선택한 대응의 상세를 확인할 수 없습니다.');
}
/** 인용의 현재 본문·판본을 함께 읽어 수동 판본 입력을 없앱니다. */
export async function readAnchorDocument(
  scope: Scope,
  document: string,
): Promise<Outcome<DocumentContent>> {
  try {
    if (!matches(await connectionGateway.getState(), scope))
      return failure('scope_changed', '현재 연결이 변경되었습니다.');
    const result = await documentsGateway.content({
      connectionId: scope.connectionId,
      document,
    });
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      !matches(await connectionGateway.getState(), scope) ||
      result.data.document !== document ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision
    )
      return failure('scope_changed', '이전 범위의 원문을 표시하지 않습니다.');
    return result;
  } catch {
    return failure('bridge_unavailable', '원문을 읽을 수 없습니다.');
  }
}
/** 준비 결과는 편집한 전체 payload와 결합하며 이전 원장이 바뀌면 새 기준을 채택하지 않습니다. */
export async function prepareCorrespondence(
  scope: Scope,
  intent: Intent,
): Promise<Outcome<Prepared>> {
  const result = await request(
    scope,
    intent.kind === 'propose'
      ? {
          connectionId: scope.connectionId,
          operation: 'correspondenceDraft',
          input: { draft: intent.value },
        }
      : {
          connectionId: scope.connectionId,
          operation: 'correspondencePrepare',
          input: {
            correspondence_id: intent.correspondenceId,
            operation: intent.kind,
            change: intent.change,
          },
        },
  );
  if (!result.ok) return result;
  const parsed = preparedSchema.safeParse(result.data);
  if (
    !parsed.success ||
    !parsed.data.complete ||
    parsed.data.truncated ||
    parsed.data.skipped.length
  )
    return failure(
      'incomplete',
      '모든 의존 근거를 준비하지 못했습니다. 초안을 보존하고 원문을 확인해 주세요.',
    );
  const prepared = parsed.data;
  if (
    intent.kind === 'propose'
      ? canonical(prepared.draft) !== canonical(intent.value)
      : canonical(prepared.prepared_change) !==
        canonical({ operation: intent.kind, change: intent.change })
  )
    return failure(
      'invalid_response',
      '준비 결과가 작성한 변경 내용과 다릅니다. 저장하지 않았습니다.',
    );
  if (
    intent.kind !== 'propose' &&
    (prepared.correspondence_id !== intent.correspondenceId ||
      prepared.correspondence_revision !== intent.baseRevision ||
      !dependenciesUnchanged(intent.baseDependencies, prepared.dependencies))
  )
    return failure(
      'conflict',
      '편집 중 판단이 변경됐습니다. 초안과 최신 이력을 대조해 주세요.',
    );
  const operations = {
    review: 'correspondenceReview',
    review_undo: 'correspondenceReviewUndo',
    policy: 'correspondencePolicy',
    policy_undo: 'correspondencePolicyUndo',
  } as const;
  const command = workspaceRequestSchema.safeParse({
    connectionId: scope.connectionId,
    operation:
      intent.kind === 'propose'
        ? 'correspondencePropose'
        : operations[intent.kind],
    input: {
      ...(intent.kind === 'propose'
        ? { draft: intent.value, reason: intent.reason }
        : intent.change),
      correspondence_id: prepared.correspondence_id,
      expected_state_revision: prepared.state_revision,
    },
  });
  if (
    !command.success ||
    ![
      'correspondencePropose',
      'correspondenceReview',
      'correspondenceReviewUndo',
      'correspondencePolicy',
      'correspondencePolicyUndo',
    ].includes(command.data.operation)
  )
    return failure('invalid_input', '준비된 변경 내용을 확인해 주세요.');
  const value = command.data;
  if (
    value.operation !== 'correspondencePropose' &&
    value.operation !== 'correspondenceReview' &&
    value.operation !== 'correspondenceReviewUndo' &&
    value.operation !== 'correspondencePolicy' &&
    value.operation !== 'correspondencePolicyUndo'
  )
    return failure('invalid_input', '지원하지 않는 변경입니다.');
  return { ok: true, data: { command: value, response: prepared, intent } };
}
/** 준비된 요청을 한 번만 저장하고 서버의 실제 이벤트 영수증을 확인합니다. */
export async function saveCorrespondence(
  scope: Scope,
  prepared: Prepared,
): Promise<Outcome<{ id: string; eventId: string; warnings: number }>> {
  const result = await request(scope, prepared.command, true);
  if (!result.ok) return result;
  const parsed = receiptSchema.safeParse(result.data);
  return parsed.success &&
    parsed.data.correspondence_id === prepared.response.correspondence_id
    ? {
        ok: true,
        data: {
          id: parsed.data.correspondence_id,
          eventId: parsed.data.event_id,
          warnings: parsed.data.cleanup_failures.length,
        },
      }
    : failure(
        'outcome_unknown',
        '저장 이벤트를 확인하지 못했습니다. 같은 변경을 다시 저장하지 마세요.',
      );
}
