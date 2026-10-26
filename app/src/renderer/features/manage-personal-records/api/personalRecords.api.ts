import { connectionGateway } from '@renderer/platform/connection';
import { workspaceGateway } from '@renderer/platform/workspace';
import { documentsGateway } from '@renderer/platform/documents';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import type { ConnectionResult } from '@contracts/connection.contract';
import type { DocumentListPage } from '@contracts/documents.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import {
  basisSchema,
  personalPageSchema,
  recordEnvelopeSchema,
  personalKind,
} from '../model/personalRecords';
import type {
  PersonalSession,
  PersonalOutcome,
  PersonalError,
  PersonalMode,
  PersonalPage,
  RecordEnvelope,
  PersonalBasis,
  ContextInput,
  PendingReceipt,
  PersonalMutation,
  ClaimSelection,
  BasisDocument,
} from '../model/personalRecords';

/** 이전 작업 공간과 주체의 개인 기록을 현재 화면에 남기지 않습니다. */
function matches(result: ConnectionResult, session: PersonalSession): boolean {
  return (
    result.ok &&
    result.data.status === 'connected' &&
    result.data.connectionId === session.connectionId &&
    result.data.userId === session.userId &&
    result.data.policyRevision === session.policyRevision &&
    result.data.selection?.tenant === session.tenant &&
    result.data.selection.profile === session.profileId
  );
}
/** 안전한 공개 오류만 renderer 상태로 전달합니다. */
export function failure<T>(code: string, message: string): PersonalOutcome<T> {
  return { ok: false, error: { code, message } };
}
/** 읽기·쓰기의 편집 당시 범위를 전송하고 완료 후 현재 연결과 다시 대조합니다. */
export async function requestPersonal(
  request: WorkspaceRequest,
  session: PersonalSession,
  mutation: boolean = false,
): Promise<PersonalOutcome<KnowledgeValue>> {
  try {
    if (!matches(await connectionGateway.getState(), session))
      return failure(
        'scope_changed',
        '작업 공간 또는 관점이 변경됐습니다. 현재 연결에서 다시 열어 주세요.',
      );
    const result = await workspaceGateway.execute({
      ...request,
      expectedScope: {
        userId: session.userId,
        tenant: session.tenant,
        profileId: session.profileId,
        policyRevision: session.policyRevision,
      },
    });
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      !matches(await connectionGateway.getState(), session) ||
      result.data.operation !== request.operation ||
      access.userId !== session.userId ||
      access.tenant !== session.tenant ||
      access.profileId !== session.profileId ||
      access.policyRevision !== session.policyRevision
    )
      return {
        ok: false,
        error: {
          code: mutation ? 'outcome_unknown' : 'scope_changed',
          status: 403,
          message: mutation
            ? '응답 전에 연결 범위가 바뀌었습니다. 이전 범위에서 저장됐을 수 있으므로 동일 요청의 수신 기록으로 확인해야 합니다.'
            : '연결 범위가 달라져 이전 응답을 표시하지 않습니다.',
        },
      };
    return { ok: true, data: result.data.data };
  } catch {
    return failure(
      mutation ? 'outcome_unknown' : 'bridge_unavailable',
      mutation
        ? '저장 응답을 확인하지 못했습니다. 동일 요청의 수신 기록으로 확인해 주세요.'
        : '현재 연결의 기록을 읽을 수 없습니다.',
    );
  }
}
/** 선택된 연결과 별도 개인 쓰기 권한을 현재 상태에서 가져옵니다. */
export async function loadPersonalSession(): Promise<
  PersonalOutcome<PersonalSession>
> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok) return result;
    if (result.data.status !== 'connected' || !result.data.selection)
      return failure(
        'connection_required',
        '서버와 작업 공간을 먼저 선택해 주세요.',
      );
    const snapshot = result.data;
    const selection = snapshot.selection;
    if (!selection)
      return failure('connection_required', '작업 공간을 먼저 선택해 주세요.');
    const workspace = snapshot.workspaces.find(
      (item: (typeof snapshot.workspaces)[number]): boolean =>
        item.id === selection.tenant,
    );
    if (!workspace)
      return failure('scope_changed', '현재 작업 공간을 확인할 수 없습니다.');
    return {
      ok: true,
      data: {
        connectionId: snapshot.connectionId,
        userId: snapshot.userId,
        tenant: selection.tenant,
        profileId: selection.profile,
        policyRevision: snapshot.policyRevision,
        permissions: workspace.permissions,
      },
    };
  } catch {
    return failure('bridge_unavailable', '서버 연결 정보를 읽을 수 없습니다.');
  }
}
/** 실제 다음 페이지를 가져오며 부분 목록과 전체 이력을 구분합니다. */
export async function listPersonal(
  mode: PersonalMode,
  session: PersonalSession,
  cursor: string | null = null,
): Promise<PersonalOutcome<PersonalPage>> {
  const result = await requestPersonal(
    {
      connectionId: session.connectionId,
      operation: mode,
      input: { limit: 20, cursor },
    },
    session,
  );
  if (!result.ok) return result;
  const parsed = personalPageSchema.safeParse(result.data);
  return parsed.success &&
    parsed.data.items.every(
      (item: PersonalPage['items'][number]): boolean =>
        item.kind === personalKind(mode),
    )
    ? { ok: true, data: parsed.data }
    : failure(
        'invalid_response',
        '개인 기록 목록의 응답을 확인할 수 없습니다.',
      );
}
/** 선택한 실재 기록의 소유자·종류를 검증하고 전체 스냅샷을 보존합니다. */
export async function readPersonal(
  mode: PersonalMode,
  id: string,
  session: PersonalSession,
): Promise<PersonalOutcome<RecordEnvelope>> {
  const operation =
    mode === 'conversations'
      ? 'conversation'
      : mode === 'savedResults'
        ? 'savedResult'
        : 'comparison';
  const result = await requestPersonal(
    { connectionId: session.connectionId, operation, input: { record_id: id } },
    session,
  );
  return result.ok
    ? parseOwnedRecord(result.data, session, personalKind(mode), id)
    : result;
}
/** 응답 원형과 실제 개인 소유권을 함께 검사합니다. */
function parseOwnedRecord(
  value: unknown,
  session: PersonalSession,
  kind: string,
  id?: string,
): PersonalOutcome<RecordEnvelope> {
  const parsed = recordEnvelopeSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.record.kind !== kind ||
    parsed.data.record.tenant !== session.tenant ||
    parsed.data.record.user_id !== session.userId ||
    (id !== undefined && parsed.data.record.id !== id)
  )
    return failure(
      'invalid_response',
      '기록의 소유자나 전체 저장 응답을 확인할 수 없습니다.',
    );
  return { ok: true, data: parsed.data };
}
/** 변경은 한 번만 보내고 잘못된 성공 응답도 결과 미확인으로 처리합니다. */
export async function writePersonal(
  request: PersonalMutation,
  receipt: PendingReceipt,
  session: PersonalSession,
): Promise<PersonalOutcome<RecordEnvelope>> {
  const result = await requestPersonal(request, session, true);
  if (!result.ok) return result;
  const parsed = parseOwnedRecord(
    result.data,
    session,
    receipt.kind,
    receipt.recordId,
  );
  if (!parsed.ok || !parsed.data.record.requests[receipt.requestId])
    return failure(
      'outcome_unknown',
      '저장 응답의 동일 요청 기록을 확인하지 못했습니다. 수신 기록을 조회해 주세요.',
    );
  return parsed;
}
/** 응답이 유실된 동일 request_id의 GET 수신 기록만 조회합니다. */
export async function confirmPersonal(
  receipt: PendingReceipt,
  session: PersonalSession,
): Promise<PersonalOutcome<RecordEnvelope>> {
  const result = await requestPersonal(
    {
      connectionId: session.connectionId,
      operation: 'personalReceipt',
      input: {
        kind: receipt.kind,
        request_id: receipt.requestId,
        ...(receipt.recordId ? { record_id: receipt.recordId } : {}),
      },
    },
    session,
  );
  if (!result.ok) return result;
  if (
    result.data.request_confirmed !== true ||
    result.data.request_id !== receipt.requestId
  )
    return failure(
      'outcome_unknown',
      '동일 요청의 저장 여부를 아직 확인할 수 없습니다.',
    );
  const parsed = parseOwnedRecord(
    result.data,
    session,
    receipt.kind,
    receipt.recordId,
  );
  if (!parsed.ok || !parsed.data.record.requests[receipt.requestId])
    return failure(
      'outcome_unknown',
      '동일 요청의 기록이 확인되지 않았습니다. 다시 저장하지 마세요.',
    );
  return parsed;
}
/** 질문 저장 전에 실제 선택 범위가 완전히 준비되는지 확인합니다. */
export async function preparePersonalContext(
  input: ContextInput,
  session: PersonalSession,
): Promise<PersonalOutcome<PersonalBasis>> {
  const result = await requestPersonal(
    { connectionId: session.connectionId, operation: 'questionContext', input },
    session,
  );
  if (!result.ok) return result;
  const parsed = basisSchema.safeParse(result.data);
  if (!parsed.success)
    return failure(
      'invalid_response',
      '질문 기준 스냅샷을 확인할 수 없습니다.',
    );
  if (
    parsed.data.skipped.some(
      (item: unknown): boolean =>
        typeof item === 'object' &&
        item !== null &&
        'code' in item &&
        item.code === 'client_conversion_required',
    )
  )
    return failure(
      'client_conversion_required',
      '이 원본은 먼저 문자 변환을 완료한 뒤 저장된 변환 보고에서 질문 화면으로 이동해 주세요. 선택한 원본은 제외하지 않았습니다.',
    );
  if (
    !parsed.data.can_prepare ||
    !parsed.data.complete ||
    parsed.data.truncated ||
    parsed.data.skipped.length > 0
  )
    return failure(
      'context_incomplete',
      '선택한 근거를 모두 준비하지 못했습니다. 범위를 확인한 뒤 다시 준비해 주세요.',
    );
  return { ok: true, data: parsed.data };
}
/** 현재 허용 문서 목록으로만 선택지를 제공하며 페이지를 지원합니다. */
export async function listContextDocuments(
  session: PersonalSession,
  cursor: string | null,
): Promise<PersonalOutcome<DocumentListPage>> {
  try {
    if (!matches(await connectionGateway.getState(), session))
      return failure('scope_changed', '작업 공간이 변경됐습니다.');
    const result = await documentsGateway.list({
      connectionId: session.connectionId,
      cursor,
      limit: 50,
    });
    if (!result.ok) return result;
    if (
      !matches(await connectionGateway.getState(), session) ||
      result.data.access.tenant !== session.tenant ||
      result.data.access.profileId !== session.profileId ||
      result.data.access.userId !== session.userId ||
      result.data.access.policyRevision !== session.policyRevision
    )
      return failure('scope_changed', '선택 범위가 변경됐습니다.');
    return result;
  } catch {
    return failure(
      'bridge_unavailable',
      '선택할 문서 목록을 읽을 수 없습니다.',
    );
  }
}
/** 비교 당시 새 주장에 한해 현재 실제 승인·정정·거절 이력과 판본을 대조합니다. */
export async function currentReviewedClaims(
  basis: PersonalBasis,
  session: PersonalSession,
): Promise<PersonalOutcome<ClaimSelection[]>> {
  try {
    if (!matches(await connectionGateway.getState(), session))
      return failure('scope_changed', '작업 공간이 변경됐습니다.');
    const results = await Promise.all(
      basis.documents.map(
        async (
          document: BasisDocument,
        ): Promise<PersonalOutcome<ClaimSelection[]>> => {
          const result = await knowledgeGateway.read({
            connectionId: session.connectionId,
            document: document.document,
          });
          if (!result.ok) return result;
          const current = result.data;
          if (
            current.access.userId !== session.userId ||
            current.access.tenant !== session.tenant ||
            current.access.profileId !== session.profileId ||
            current.access.policyRevision !== session.policyRevision
          )
            return failure('scope_changed', '지식 조회 범위가 변경됐습니다.');
          if (
            current.sourceRevision !== document.knowledge.source_revision ||
            current.graphRevision !== document.knowledge.graph_revision
          )
            return failure(
              'comparison_stale',
              '비교에 저장된 원문·추출 판본이 바뀌었습니다. 새 비교를 만들어 대조해 주세요.',
            );
          const stored = new Set(
            document.knowledge.claims.map(
              (claim: BasisDocument['knowledge']['claims'][number]): string =>
                claim.claim_id,
            ),
          );
          return {
            ok: true,
            data: current.claims
              .filter(
                (claim: (typeof current.claims)[number]): boolean =>
                  stored.has(claim.claim_id) &&
                  ['accept', 'edit', 'reject'].includes(claim.decision) &&
                  !claim.ambiguous,
              )
              .map(
                (claim: (typeof current.claims)[number]): ClaimSelection => ({
                  document: document.document,
                  claim_id: claim.claim_id,
                  state_revision: current.stateRevision,
                }),
              ),
          };
        },
      ),
    );
    if (!matches(await connectionGateway.getState(), session))
      return failure('scope_changed', '작업 공간이 변경됐습니다.');
    const error = results.find(
      (
        result: PersonalOutcome<ClaimSelection[]>,
      ): result is { ok: false; error: PersonalError } => !result.ok,
    );
    if (error) return error;
    return {
      ok: true,
      data: results.flatMap(
        (result: PersonalOutcome<ClaimSelection[]>): ClaimSelection[] =>
          result.ok ? result.data : [],
      ),
    };
  } catch {
    return failure(
      'bridge_unavailable',
      '현재 실제 검토 상태를 읽지 못했습니다. 완료 기록을 저장하지 않았습니다.',
    );
  }
}
