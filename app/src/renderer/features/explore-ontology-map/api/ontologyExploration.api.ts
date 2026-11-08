import type { z } from 'zod';
import {
  ontologyNeighborPageSchema,
  ontologySearchPageSchema,
  ontologyGlossaryCardSchema,
} from '@contracts/ontologyExploration.contract';
import type {
  OntologyNeighborsInput,
  OntologyNeighborPage,
  OntologySearchInput,
  OntologySearchPage,
  OntologyGlossaryInput,
  OntologyGlossaryCard,
} from '@contracts/ontologyExploration.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import { validateOntologyScope } from './ontologyMap.api';
import type {
  OntologyOutcome,
  OntologyScope,
} from '../model/ontologyMap.types';

type ExplorationRequest = Extract<
  WorkspaceRequest,
  { operation: 'ontologySearch' | 'ontologyNeighbors' | 'ontologyGlossary' }
>;

/** 응답의 페이지와 권한을 함께 검사하고 늦은 범위의 자료는 반환하지 않습니다. */
async function executePage<T>(
  scope: OntologyScope,
  request: ExplorationRequest,
  schema: z.ZodType<T>,
): Promise<OntologyOutcome<T>> {
  try {
    const before = await validateOntologyScope(scope);
    if (!before.ok) return before;
    const result = await workspaceGateway.execute({
      ...request,
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
    const after = await validateOntologyScope(scope);
    if (!after.ok) return after;
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      result.data.operation !== request.operation ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      !sameAccessRevision(scope, access)
    )
      return {
        ok: false,
        error: {
          code: 'scope_changed',
          message: '조회 범위가 변경되었습니다. 다시 불러와 주세요.',
        },
      };
    const parsed = schema.safeParse(result.data.data);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : {
          ok: false,
          error: {
            code: 'response_invalid',
            message: '검색 응답을 확인하지 못했습니다. 다시 시도해 주세요.',
          },
        };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '검색을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
      },
    };
  }
}

/** 용어 카드는 현재 선택의 문서·개체·판본이 일치할 때만 반환합니다. */
export async function loadOntologyGlossary(
  scope: OntologyScope,
  input: OntologyGlossaryInput,
): Promise<OntologyOutcome<OntologyGlossaryCard>> {
  const result = await executePage(
    scope,
    {
      connectionId: scope.connectionId,
      operation: 'ontologyGlossary',
      input,
    },
    ontologyGlossaryCardSchema,
  );
  if (!result.ok) return result;
  if (
    result.data.document.document !== input.document ||
    result.data.entity.id !== input.entity_id ||
    result.data.document.state_revision !== input.expected_state_revision ||
    (result.data.source_passage !== null &&
      result.data.source_passage.source_revision !==
        result.data.document.source_revision)
  )
    return {
      ok: false,
      error: {
        code: 'response_invalid',
        message:
          '선택한 개념과 용어 설명의 판본이 다릅니다. 다시 불러와 주세요.',
      },
    };
  return result;
}

/** 검색 페이지는 전체 문서를 열지 않고 서버 색인의 실제 cursor로 읽습니다. */
export function searchOntology(
  scope: OntologyScope,
  input: OntologySearchInput,
): Promise<OntologyOutcome<OntologySearchPage>> {
  return executePage(
    scope,
    { connectionId: scope.connectionId, operation: 'ontologySearch', input },
    ontologySearchPageSchema,
  );
}

/** 선택한 개체의 관계만 같은 판본을 기준으로 이어 읽습니다. */
export function loadOntologyNeighbors(
  scope: OntologyScope,
  input: OntologyNeighborsInput,
): Promise<OntologyOutcome<OntologyNeighborPage>> {
  return executePage(
    scope,
    { connectionId: scope.connectionId, operation: 'ontologyNeighbors', input },
    ontologyNeighborPageSchema,
  );
}
