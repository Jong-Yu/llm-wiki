import type { ConnectionResult } from '@contracts/connection.contract';
import type { DocumentListItem } from '@contracts/documents.contract';
import type {
  KnowledgeJson,
  KnowledgeValue,
  KnowledgeClaim,
} from '@contracts/knowledge.contract';
import type {
  WorkspaceRequest,
  WorkspaceResponse,
  WorkspaceScope,
  WorkspaceResult,
} from '@contracts/workspace.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { workspaceGateway } from '@renderer/platform/workspace';
import type {
  ExplorerMode,
  ExplorerValues,
} from '../model/explorerForm.schema';
import { splitReferences } from '../model/explorerForm.schema';

export type ExplorerScope = WorkspaceScope & {
  connectionId: string;
  domain: string | null;
  viewpoint: string | null;
};
export type ExplorerError = Extract<WorkspaceResult, { ok: false }>['error'];
export type ExplorerOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: ExplorerError };
export type ExplorerCatalog = {
  scope: ExplorerScope;
  items: DocumentListItem[];
  nextCursor: string | null;
  complete: boolean;
  truncated: boolean;
  skippedCount: number;
};
export type ClaimOption = {
  key: string;
  label: string;
  document: string;
  claimId: string;
  stateRevision: string;
  collection: KnowledgeClaim['collection'];
  value: KnowledgeValue;
  reviewedValue: KnowledgeValue;
  ambiguous: boolean;
};
export type ExplorerReviewSelection = {
  document: string;
  claimId: string;
  stateRevision: string;
  collection: KnowledgeClaim['collection'];
  value: KnowledgeValue;
  reviewedValue?: KnowledgeValue;
  ambiguous?: boolean;
  title?: string;
};

/** 현재 허용된 선택에서 표시/대조에 필요한 공개 범위만 가져옵니다. */
function selectedScope(result: ConnectionResult): ExplorerScope | null {
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  const current = result.data;
  const selected = current.selection;
  if (!selected) return null;
  const membership = current.workspaces.find(
    (item: (typeof current.workspaces)[number]): boolean =>
      item.id === selected.tenant,
  );
  const profile = membership?.profiles.find(
    (item: NonNullable<typeof membership>['profiles'][number]): boolean =>
      item.id === selected.profile,
  );
  if (!membership?.permissions.includes('read') || !profile) return null;
  return {
    connectionId: current.connectionId,
    userId: current.userId,
    tenant: selected.tenant,
    profileId: selected.profile,
    policyRevision: current.policyRevision,
    domain: profile.domain,
    viewpoint: profile.viewpoint,
  };
}

/** 같은 연결에서도 사용자·관점·정책이 바뀌면 이전 응답을 버립니다. */
function sameScope(
  left: ExplorerScope | null,
  right: ExplorerScope | null,
): boolean {
  return (
    !!left &&
    !!right &&
    left.connectionId === right.connectionId &&
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    left.policyRevision === right.policyRevision &&
    left.domain === right.domain &&
    left.viewpoint === right.viewpoint
  );
}

/** 원격 예외 원문 대신 공개 조회 안내만 반환합니다. */
function failure(
  code: string,
  message: string,
): { ok: false; error: ExplorerError } {
  return { ok: false, error: { code, message } };
}

/** 문서/원본 선택은 실제 목록의 서버 cursor로만 확장합니다. */
export async function loadExplorerCatalog(
  cursor: string | null,
  expected?: ExplorerScope,
): Promise<ExplorerOutcome<ExplorerCatalog>> {
  try {
    const scope = selectedScope(await connectionGateway.getState());
    if (!scope)
      return failure('selection_required', '작업 공간을 먼저 선택해 주세요.');
    if (expected && !sameScope(scope, expected))
      return failure(
        'scope_changed',
        '조회 범위가 변경되었습니다. 새로고침해 주세요.',
      );
    const result = await documentsGateway.list({
      connectionId: scope.connectionId,
      cursor,
      limit: 50,
    });
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return failure(
        'scope_changed',
        '조회 중 연결 또는 관점이 변경되었습니다.',
      );
    if (!result.ok) return result;
    if (
      result.data.access.userId !== scope.userId ||
      result.data.access.tenant !== scope.tenant ||
      result.data.access.profileId !== scope.profileId ||
      result.data.access.policyRevision !== scope.policyRevision
    )
      return failure('scope_changed', '자료의 조회 범위를 확인할 수 없습니다.');
    return {
      ok: true,
      data: {
        scope,
        items: result.data.items,
        nextCursor: result.data.nextCursor,
        complete: result.data.complete,
        truncated: result.data.truncated,
        skippedCount: result.data.skipped.length,
      },
    };
  } catch {
    return failure(
      'bridge_unavailable',
      '문서 선택 목록을 읽지 못했습니다. 서버 연결을 확인해 주세요.',
    );
  }
}

/** 읽기 operation만 만들고 profile/tenant/actor는 main에 맡깁니다. */
function queryRequest(
  mode: ExplorerMode,
  values: ExplorerValues,
  catalog: ExplorerCatalog,
  claims: ClaimOption[],
  cursor: string | null,
  target?: KnowledgeValue,
): WorkspaceRequest {
  const scope = catalog.scope;
  const base = {
    connectionId: scope.connectionId,
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
    },
  };
  const documents = values.documents;
  const correspondences = splitReferences(values.correspondenceIds);
  if (mode === 'review')
    return {
      ...base,
      operation: 'reviewQueue',
      input: {
        documents,
        correspondence_ids: correspondences,
        states: values.states,
        limit: values.limit,
        cursor,
      },
    };
  if (mode === 'history')
    return {
      ...base,
      operation: 'history',
      input: {
        documents,
        correspondence_ids: correspondences,
        job_ids: splitReferences(values.jobIds),
        limit: values.limit,
        cursor,
      },
    };
  if (mode === 'questions') {
    const selectedClaims = claims
      .filter((item: ClaimOption): boolean => values.claims.includes(item.key))
      .map(
        (
          item: ClaimOption,
        ): { document: string; claim_id: string; state_revision: string } => ({
          document: item.document,
          claim_id: item.claimId,
          state_revision: item.stateRevision,
        }),
      );
    const originals = catalog.items
      .filter(
        (item: DocumentListItem): boolean =>
          item.kind === 'source' && values.sourceIds.includes(item.sourceId),
      )
      .flatMap(
        (
          item: DocumentListItem,
        ): {
          source_id: string;
          source_version: string;
          source_sha256: string;
        }[] =>
          item.kind === 'source'
            ? [
                {
                  source_id: item.sourceId,
                  source_version: item.sourceVersion,
                  source_sha256: item.sourceSha256,
                },
              ]
            : [],
      );
    return {
      ...base,
      operation: 'questionContext',
      input: {
        documents,
        required_documents: values.requiredDocuments,
        claims: selectedClaims,
        source_refs: originals,
      },
    };
  }
  if (target)
    return {
      ...base,
      operation: 'conceptQuery',
      input: {
        target,
        documents: documents.length ? documents : undefined,
        correspondence_ids: correspondences,
        expansion: values.expansion ? 'direct_confirmed' : 'none',
        limit: values.limit,
      },
    };
  if (values.operation === 'search')
    return {
      ...base,
      operation: 'search',
      input: { query: values.query, limit: Math.min(50, values.limit) },
    };
  if (values.operation === 'conceptFind')
    return {
      ...base,
      operation: 'conceptFind',
      input: {
        text: values.query,
        documents: documents.length ? documents : undefined,
        include_history: values.includeHistory,
        limit: values.limit,
      },
    };
  if (values.operation === 'context')
    return { ...base, operation: 'context', input: { documents } };
  const document = documents[0] || '';
  if (values.operation === 'ontology')
    return { ...base, operation: 'ontology', input: { document } };
  if (values.operation === 'connections')
    return {
      ...base,
      operation: 'connections',
      input: { document, limit: values.limit },
    };
  return {
    ...base,
    operation: 'impact',
    input: { document, limit: values.limit },
  };
}

/** 요청 전후 현재 범위를 확인해 명시한 선택 범위의 응답만 표시합니다. */
export async function queryExplorer(
  mode: ExplorerMode,
  values: ExplorerValues,
  catalog: ExplorerCatalog,
  claims: ClaimOption[],
  cursor: string | null,
  target?: KnowledgeValue,
): Promise<ExplorerOutcome<WorkspaceResponse>> {
  try {
    if (
      !sameScope(
        catalog.scope,
        selectedScope(await connectionGateway.getState()),
      )
    )
      return failure(
        'scope_changed',
        '선택한 작업 공간이 변경되었습니다. 자료를 다시 선택해 주세요.',
      );
    const result = await workspaceGateway.execute(
      queryRequest(mode, values, catalog, claims, cursor, target),
    );
    if (
      !sameScope(
        catalog.scope,
        selectedScope(await connectionGateway.getState()),
      )
    )
      return failure(
        'scope_changed',
        '조회 중 관점이나 권한이 변경되어 이전 결과를 숨겼습니다.',
      );
    return result;
  } catch {
    return failure(
      'bridge_unavailable',
      '선택 범위의 자료를 조회하지 못했습니다. 다시 시도해 주세요.',
    );
  }
}

/** 개체 이름은 해당 문서의 실제 그래프에서만 해석합니다. */
function claimLabel(
  claim: KnowledgeClaim,
  entities: { id: string; label: string }[],
): string {
  const value = claim.reviewed_value;
  const label = (raw: KnowledgeJson | undefined): string => {
    if (typeof raw === 'string')
      return (
        entities.find(
          (item: { id: string; label: string }): boolean => item.id === raw,
        )?.label || raw
      );
    return typeof raw === 'number' ? String(raw) : '';
  };
  return [
    label(value.subject),
    typeof value.predicate === 'string'
      ? value.predicate
      : typeof value.property === 'string'
        ? value.property
        : '주장',
    label(value.object) || label(value.value),
  ]
    .filter(Boolean)
    .join(' → ');
}

/** 질문/검토의 주장 선택은 최신 knowledge의 실제 claim/state 참조로 만듭니다. */
export async function loadExplorerClaims(
  documents: string[],
  scope: ExplorerScope,
): Promise<ExplorerOutcome<ClaimOption[]>> {
  try {
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return failure('scope_changed', '현재 관점을 다시 확인해 주세요.');
    const results = await Promise.all(
      documents.map(
        async (document: string): Promise<ExplorerOutcome<ClaimOption[]>> => {
          const result = await knowledgeGateway.read({
            connectionId: scope.connectionId,
            document,
          });
          if (!result.ok) return result;
          const value = result.data;
          if (
            value.access.userId !== scope.userId ||
            value.access.tenant !== scope.tenant ||
            value.access.profileId !== scope.profileId ||
            value.access.policyRevision !== scope.policyRevision
          )
            return failure(
              'scope_changed',
              '주장의 조회 기준이 변경되었습니다.',
            );
          const entities = [
            ...value.effectiveGraph.entities,
            ...value.machineGraph.entities,
          ];
          return {
            ok: true,
            data: value.claims.map((claim: KnowledgeClaim): ClaimOption => ({
              key: JSON.stringify([
                document,
                claim.claim_id,
                value.stateRevision,
              ]),
              label: claimLabel(claim, entities),
              document,
              claimId: claim.claim_id,
              stateRevision: value.stateRevision,
              collection: claim.collection,
              value: claim.value,
              reviewedValue: claim.reviewed_value,
              ambiguous: claim.ambiguous,
            })),
          };
        },
      ),
    );
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return failure('scope_changed', '조회 중 관점이 변경되었습니다.');
    const output: ClaimOption[] = [];
    for (const result of results) {
      if (!result.ok) return result;
      output.push(...result.data);
    }
    return { ok: true, data: output };
  } catch {
    return failure(
      'bridge_unavailable',
      '선택한 문서의 주장을 확인하지 못했습니다.',
    );
  }
}
