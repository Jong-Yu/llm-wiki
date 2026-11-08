import type { z } from 'zod';
import { sameAccessRevision } from '@contracts/connection.contract';
import type {
  WorkspaceRequest,
  WorkspaceScope,
} from '@contracts/workspace.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import type {
  OntologyOutcome,
  OntologyScope,
} from '../model/ontologyMap.types';
import { invalidatesScope, validateOntologyScope } from './ontologyMap.api';

export type CleanupOperation = Extract<
  WorkspaceRequest,
  {
    operation:
      | 'cleanupPreview'
      | 'cleanupApply'
      | 'cleanupHistory'
      | 'cleanupRequest'
      | 'cleanupUndo';
  }
>;

/** 사용자·공간·관점 기준만 보내며 인증 비밀과 UI 권한 목록은 보내지 않습니다. */
export function cleanupScope(scope: OntologyScope): WorkspaceScope {
  return {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
    ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
  };
}

/** 저장은 한 번만 전송하고 응답 유실·형식 오류는 영수증 조회가 필요한 상태로 돌립니다. */
export async function executeCleanup<T>(
  scope: OntologyScope,
  request: CleanupOperation,
  schema: z.ZodType<T>,
): Promise<OntologyOutcome<T>> {
  const mutation =
    request.operation === 'cleanupApply' || request.operation === 'cleanupUndo';
  let dispatched = false;
  try {
    const current = await validateOntologyScope(scope);
    if (!current.ok) return current;
    dispatched = true;
    const result = await workspaceGateway.execute(request);
    const after = await validateOntologyScope(scope);
    if (!after.ok) {
      if (mutation && !invalidatesScope(after.error))
        throw new Error('scope_unconfirmed');
      return after;
    }
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      result.data.connectionId !== scope.connectionId ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      !sameAccessRevision(access, scope)
    )
      return {
        ok: false,
        error: {
          code: 'scope_changed',
          message:
            '연결 또는 작업 공간이 변경되었습니다. 원래 범위에서 이력을 확인해 주세요.',
        },
      };
    const parsed = schema.safeParse(result.data.data);
    if (
      result.data.operation !== request.operation ||
      result.data.data.document !== request.input.document ||
      !parsed.success
    )
      throw new Error('invalid_cleanup_response');
    if (
      (request.operation === 'cleanupApply' ||
        request.operation === 'cleanupUndo' ||
        request.operation === 'cleanupRequest') &&
      result.data.data.request_id !== request.input.request_id
    )
      throw new Error('receipt_mismatch');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error:
        mutation && dispatched
          ? {
              code: 'outcome_unknown',
              message:
                '저장 결과를 확인하지 못했습니다. 저장 결과 확인으로 조회해 주세요.',
              retry: 'reconcile',
            }
          : {
              code: 'read_failed',
              message:
                '정리 정보를 불러오지 못했습니다. 연결을 확인한 뒤 다시 조회해 주세요.',
            },
    };
  }
}
