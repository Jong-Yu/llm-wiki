import { sameAccessRevision } from '@contracts/connection.contract';
import { z } from 'zod';
import type { ConnectionResult } from '@contracts/connection.contract';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type {
  WorkspaceRequest,
  WorkspaceScope,
} from '@contracts/workspace.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { workspaceGateway } from '@renderer/platform/workspace';
import type {
  CorrectionBasis,
  CorrectionReceipt,
  MapAssertion,
  OntologyFailure,
  OntologyOutcome,
  OntologyScope,
  OntologySnapshot,
} from '../model/ontologyMap.types';

/** 연결에서 실제 허용된 공간·관점만 추려 요청 기준으로 고정합니다. */
function readScope(result: ConnectionResult): OntologyScope | null {
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  const current = result.data;
  const selection = current.selection;
  if (!selection) return null;
  const membership = current.workspaces.find(
    (item: (typeof current.workspaces)[number]): boolean =>
      item.id === selection.tenant,
  );
  if (
    !membership?.permissions.includes('read') ||
    !membership.profiles.some(
      (profile: (typeof membership.profiles)[number]): boolean =>
        profile.id === selection.profile,
    )
  )
    return null;
  return {
    connectionId: current.connectionId,
    userId: current.userId,
    tenant: selection.tenant,
    profileId: selection.profile,
    policyRevision: current.policyRevision,
    ...(current.accessRevision
      ? { accessRevision: current.accessRevision }
      : {}),
    permissions: membership.permissions,
  };
}

/** 전역 검색도 기존 지도와 같은 연결·권한 기준을 고정합니다. */
export async function readOntologyScope(): Promise<
  OntologyOutcome<OntologyScope>
> {
  try {
    const scope = readScope(await connectionGateway.getState());
    return scope
      ? { ok: true, data: scope }
      : failure(
          'selection_required',
          '연결 화면에서 작업 공간을 선택해 주세요.',
        );
  } catch {
    return failure(
      'bridge_unavailable',
      '현재 연결 범위를 확인하지 못했습니다.',
    );
  }
}

/** 연결 ID 외에 사용자·정책·관점 변경도 다른 조회 범위로 취급합니다. */
function sameScope(left: OntologyScope, right: OntologyScope | null): boolean {
  return (
    !!right &&
    left.connectionId === right.connectionId &&
    sameAccess(left, right)
  );
}

/** 응답에 포함된 서버 권한 기준을 요청 당시 기준과 대조합니다. */
function sameAccess(left: WorkspaceScope, right: WorkspaceScope): boolean {
  return (
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    sameAccessRevision(left, right)
  );
}

/** 공개 안내만 반환하고 원격 예외나 인증정보는 노출하지 않습니다. */
function failure(
  code: string,
  message: string,
): { ok: false; error: OntologyFailure } {
  return { ok: false, error: { code, message } };
}

/** 권한 오류에는 이전 그래프와 초안도 현재 화면에서 숨겨야 합니다. */
export function invalidatesScope(error: OntologyFailure): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    [
      'scope_changed',
      'access_unavailable',
      'subject_changed',
      'connection_changed',
      'selection_required',
      'not_connected',
      'forbidden',
      'unauthorized',
    ].includes(error.code)
  );
}

/** 창 재활성화 시 저장된 그래프가 여전히 허용된 범위인지 재확인합니다. */
export async function validateOntologyScope(
  scope: OntologyScope,
): Promise<OntologyOutcome<null>> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok) return result;
    return sameScope(scope, readScope(result))
      ? { ok: true, data: null }
      : failure(
          'scope_changed',
          '연결 또는 작업 공간이 변경되었습니다. 현재 범위에서 다시 불러와 주세요.',
        );
  } catch {
    return failure(
      'bridge_unavailable',
      '현재 연결 범위를 확인하지 못했습니다.',
    );
  }
}

/** 실제 목록 cursor로 한 페이지씩 읽으며 동명 개념을 문서 사이에서 병합하지 않습니다. */
export async function loadOntologyPage(
  cursor: string | null,
  expected?: OntologyScope,
  document?: string | null,
): Promise<OntologyOutcome<OntologySnapshot>> {
  try {
    const scope = readScope(await connectionGateway.getState());
    if (!scope)
      return failure(
        'selection_required',
        '연결 화면에서 작업 공간을 선택해 주세요.',
      );
    if (expected && !sameScope(expected, scope))
      return failure(
        'scope_changed',
        '연결이나 작업 공간이 변경되었습니다. 새로 불러와 주세요.',
      );
    if (document) {
      const result = await reloadOntologyDocument(document, scope);
      if (!result.ok) return result;
      return {
        ok: true,
        data: {
          scope,
          documents: [result.data],
          nextCursor: null,
          incomplete: false,
          skipped: [],
        },
      };
    }
    const page = await documentsGateway.list({
      connectionId: scope.connectionId,
      cursor,
      limit: 20,
    });
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '문서 목록을 읽는 동안 연결 또는 작업 공간이 변경되었습니다.',
      );
    if (!page.ok) return page;
    if (!sameAccess(scope, page.data.access))
      return failure(
        'scope_changed',
        '문서 목록의 조회 범위가 변경되었습니다.',
      );
    const documents: DocumentKnowledge[] = [];
    // 한 번에 전체 저장소를 읽지 않고 서버가 반환한 페이지의 Wiki만 조회합니다.
    const paths = page.data.items.flatMap(
      (item: (typeof page.data.items)[number]): string[] =>
        item.kind === 'wiki' ? [item.document] : [],
    );
    for (let offset = 0; offset < paths.length; offset += 4) {
      const results = await Promise.all(
        paths
          .slice(offset, offset + 4)
          .map(
            async (
              document: string,
            ): Promise<OntologyOutcome<DocumentKnowledge>> => {
              const result = await knowledgeGateway.read({
                connectionId: scope.connectionId,
                document,
              });
              if (!result.ok) return result;
              if (
                result.data.document !== document ||
                !sameAccess(scope, result.data.access)
              )
                return failure(
                  'scope_changed',
                  '그래프의 조회 범위를 확인할 수 없습니다.',
                );
              return result;
            },
          ),
      );
      // 실패 응답에서도 범위를 먼저 확인해야 이전 tenant 그래프를 보존하지 않습니다.
      if (!sameScope(scope, readScope(await connectionGateway.getState())))
        return failure(
          'scope_changed',
          '그래프를 읽는 동안 연결 또는 작업 공간이 변경되었습니다.',
        );
      for (const result of results) {
        if (!result.ok) return result;
        documents.push(result.data);
      }
    }
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '조회 중 연결 또는 작업 공간이 변경되었습니다.',
      );
    return {
      ok: true,
      data: {
        scope,
        documents,
        nextCursor: page.data.nextCursor,
        incomplete:
          !page.data.complete ||
          page.data.truncated ||
          page.data.skipped.length > 0,
        skipped: page.data.skipped.map(
          (item: (typeof page.data.skipped)[number]): string =>
            `${item.document}: ${item.code}`,
        ),
      },
    };
  } catch {
    return failure(
      'bridge_unavailable',
      '온톨로지를 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.',
    );
  }
}

/** 수정 시작 시 실제 원문과 현재 주장·판본을 읽고 기존 그래프 기준과 대조합니다. */
export async function loadCorrectionBasis(
  assertion: MapAssertion,
  scope: OntologyScope,
  mode: 'correction' | 'review' = 'correction',
): Promise<OntologyOutcome<CorrectionBasis>> {
  try {
    const current = readScope(await connectionGateway.getState());
    if (!sameScope(scope, current))
      return failure('scope_changed', '연결 또는 작업 공간이 변경되었습니다.');
    if (
      mode === 'correction' &&
      !current?.permissions.includes('ontology_review')
    )
      return failure(
        'review_not_allowed',
        '현재 작업 공간에는 원문 근거 정정 권한이 없습니다.',
      );
    if (
      mode === 'correction' &&
      (assertion.origin === 'candidate' ||
        assertion.claim?.collection === 'relation_candidates')
    )
      return failure(
        'candidate_edit_unsupported',
        '현재 API는 후보 문구 수정 시 관계로 확정합니다. 미확정 상태를 유지하기 위해 이 화면에서는 후보 저장을 지원하지 않습니다.',
      );
    if (
      mode === 'correction' &&
      (!assertion.claim || assertion.claim.decision === 'policy')
    )
      return failure(
        'policy_edit_unsupported',
        '전문가 정책은 별도 판단입니다. 원문 근거 정정으로 덮어쓸 수 없습니다.',
      );
    const [knowledge, body] = await Promise.all([
      knowledgeGateway.read({
        connectionId: scope.connectionId,
        document: assertion.document,
      }),
      documentsGateway.content({
        connectionId: scope.connectionId,
        document: assertion.document,
      }),
    ]);
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '수정 기준을 읽는 동안 권한 범위가 변경되었습니다.',
      );
    if (!knowledge.ok) return knowledge;
    if (!body.ok) return body;
    if (
      !sameAccess(scope, knowledge.data.access) ||
      !sameAccess(scope, body.data.access)
    )
      return failure(
        'scope_changed',
        '수정 기준의 권한 범위를 확인할 수 없습니다.',
      );
    const data = knowledge.data;
    const claim = data.claims.find(
      (item: (typeof data.claims)[number]): boolean =>
        item.claim_id === assertion.claim?.claim_id,
    );
    if (
      data.document !== assertion.document ||
      body.data.document !== assertion.document ||
      data.stateRevision !== assertion.knowledge.stateRevision ||
      data.sourceRevision !== body.data.revision
    )
      return failure(
        'conflict',
        '원문 또는 그래프가 변경되었습니다. 그래프를 다시 불러와 대조한 뒤 수정해 주세요.',
      );
    const version = data.machineGraph.schema_version;
    if (
      mode === 'correction' &&
      (data.status !== 'ready' ||
        data.machineGraph.needs_reextraction === true ||
        ![3, 4, 5, 6].includes(typeof version === 'number' ? version : 0) ||
        !claim ||
        claim.ambiguous)
    )
      return failure(
        'review_basis_unavailable',
        '현재 원문 기준의 수정 대상을 확인할 수 없습니다. 문서의 추출 상태를 확인해 주세요.',
      );
    return {
      ok: true,
      data: {
        scope,
        assertion: {
          ...assertion,
          claim: claim ?? assertion.claim,
          knowledge: data,
          value: claim?.reviewed_value ?? assertion.value,
        },
        body: body.data.content,
      },
    };
  } catch {
    return failure(
      'bridge_unavailable',
      '수정 기준과 원문을 읽지 못했습니다. 기존 그래프를 유지합니다.',
    );
  }
}

const receiptSchema = z.object({
  document: z.string(),
  event_id: z.string().regex(/^[a-f0-9]{32}$/),
  state_revision: z.string().regex(/^[a-f0-9]{64}$/),
  changed: z.literal(true),
  cleanup_failures: z.array(z.json()),
});

const relationReceiptSchema = receiptSchema.extend({
  changed: z.boolean(),
  saved: z.literal(true),
  replayed: z.boolean(),
  request_id: z.string().regex(/^[a-f0-9]{32}$/),
});

/** 읽은 상태 판본을 그대로 보내며 저장 결과가 불명확하면 재전송을 막습니다. */
export async function saveOntologyDecision(
  basis: CorrectionBasis,
  command: Extract<
    WorkspaceRequest,
    {
      operation:
        | 'review'
        | 'policy'
        | 'reviewUndo'
        | 'policyUndo'
        | 'relationCreate'
        | 'relationUndo'
        | 'relationRequest';
    }
  >,
): Promise<OntologyOutcome<CorrectionReceipt>> {
  try {
    const { scope, assertion } = basis;
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '연결 또는 작업 공간이 변경되어 저장을 중단했습니다.',
      );
    const result = await workspaceGateway.execute({
      ...command,
      connectionId: scope.connectionId,
      expectedScope: {
        userId: scope.userId,
        tenant: scope.tenant,
        profileId: scope.profileId,
        policyRevision: scope.policyRevision,
        ...(scope.accessRevision
          ? { accessRevision: scope.accessRevision }
          : {}),
      },
    });
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '저장 중 연결 또는 작업 공간이 변경되었습니다. 해당 범위에서 이력을 확인해 주세요.',
      );
    if (!result.ok) {
      if (
        result.error.retry === 'read_again' ||
        (result.error.status &&
          result.error.status >= 500 &&
          result.error.retry !== 'same_basis')
      )
        return {
          ok: false,
          error: {
            ...result.error,
            code: 'outcome_unknown',
            message:
              '저장 결과를 확인하지 못했습니다. 수정안은 보존했습니다. 문서 이력을 확인하기 전에는 다시 적용하지 마세요.',
          },
        };
      return result;
    }
    const parsed = (
      command.operation.startsWith('relation')
        ? relationReceiptSchema
        : receiptSchema
    ).safeParse(result.data.data);
    if (
      !sameAccess(scope, result.data.access) ||
      result.data.operation !== command.operation ||
      !parsed.success ||
      parsed.data.document !== assertion.document ||
      ('request_id' in command.input &&
        result.data.data.request_id !== command.input.request_id)
    )
      return failure(
        'outcome_unknown',
        '저장 영수증을 확인하지 못했습니다. 문서 이력을 먼저 확인해 주세요.',
      );
    return {
      ok: true,
      data: {
        eventId: parsed.data.event_id,
        stateRevision: parsed.data.state_revision,
        cleanupWarningCount: parsed.data.cleanup_failures.length,
      },
    };
  } catch {
    return failure(
      'outcome_unknown',
      '저장 응답을 받지 못했습니다. 수정안은 보존했습니다. 문서 이력을 확인하기 전에는 다시 적용하지 마세요.',
    );
  }
}

/** 단순 정정도 검토 공통 전송의 판본·영수증 검사를 사용합니다. */
export async function saveOntologyCorrection(
  basis: CorrectionBasis,
  replacement: KnowledgeValue,
  reason: string,
): Promise<OntologyOutcome<CorrectionReceipt>> {
  const claim = basis.assertion.claim;
  if (
    !claim ||
    claim.collection === 'relation_candidates' ||
    claim.decision === 'policy'
  )
    return failure(
      'unsupported_correction',
      '이 대상에는 원문 근거 정정을 적용할 수 없습니다.',
    );
  return saveOntologyDecision(basis, {
    connectionId: basis.scope.connectionId,
    operation: 'review',
    input: {
      document: basis.assertion.document,
      claim_id: claim.claim_id,
      expected_state_revision: basis.assertion.knowledge.stateRevision,
      action: 'edit',
      replacement,
      reason,
    },
  });
}

/** 저장한 문서 하나만 다시 읽어 기존 페이지 범위와 선택을 보존합니다. */
export async function reloadOntologyDocument(
  document: string,
  scope: OntologyScope,
): Promise<OntologyOutcome<DocumentKnowledge>> {
  try {
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure('scope_changed', '연결 또는 작업 공간이 변경되었습니다.');
    const result = await knowledgeGateway.read({
      connectionId: scope.connectionId,
      document,
    });
    if (!sameScope(scope, readScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '조회 중 연결 또는 작업 공간이 변경되었습니다.',
      );
    if (!result.ok) return result;
    if (
      result.data.document !== document ||
      !sameAccess(scope, result.data.access)
    )
      return failure('scope_changed', '조회 범위를 확인하지 못했습니다.');
    return result;
  } catch {
    return failure(
      'bridge_unavailable',
      '저장 후 문서를 읽지 못했습니다. 저장을 반복하지 말고 새로 조회해 주세요.',
    );
  }
}
