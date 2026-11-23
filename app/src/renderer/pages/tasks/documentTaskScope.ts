import type { DocumentTaskSession } from '@contracts/documentTasks.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';

/** 현재 선택의 전체 접근 기준을 기기 작업 기록 요청에 전달합니다. */
export function documentTaskScope(
  scope: SourceConversionScope,
): DocumentTaskSession {
  return {
    connectionId: scope.connectionId,
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
      ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
    },
  };
}
