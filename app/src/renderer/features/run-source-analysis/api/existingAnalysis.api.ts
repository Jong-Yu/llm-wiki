import type {
  AnalysisDetailResult,
  AnalysisExecutionScope,
  AnalysisExecuteRequest,
  AnalysisExecutionInspectionResult,
} from '@contracts/analysis.contract';
import type { ConnectionResult } from '@contracts/connection.contract';
import { analysisGateway } from '@renderer/platform/analysis';
import { connectionGateway } from '@renderer/platform/connection';

type Failure = Extract<AnalysisDetailResult, { ok: false }>;
/** 조회 전후 같은 사용자·관점·정책 범위인지 대조합니다. */
function sameScope(
  scope: AnalysisExecutionScope,
  result: ConnectionResult,
): boolean {
  if (!result.ok || result.data.status !== 'connected') return false;
  return (
    result.data.connectionId === scope.connectionId &&
    result.data.userId === scope.userId &&
    result.data.selection?.tenant === scope.tenant &&
    result.data.selection.profile === scope.profileId &&
    result.data.policyRevision === scope.policyRevision
  );
}
/** 사용자 선택이 바뀌면 이전 응답으로 실행하지 않습니다. */
function changed(): Failure {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '작업 공간·관점 또는 연결이 변경되었습니다. 현재 선택에서 다시 열어 주세요.',
    },
  };
}
/** 범위 확인은 실행·조회 모두에 적용하고 임의 IPC나 원문 오류를 공개하지 않습니다. */
async function scoped<
  T extends AnalysisDetailResult | AnalysisExecutionInspectionResult,
>(
  scope: AnalysisExecutionScope,
  operation: () => Promise<T>,
): Promise<T | Failure> {
  try {
    if (!sameScope(scope, await connectionGateway.getState())) return changed();
    const result = await operation();
    if (!sameScope(scope, await connectionGateway.getState())) return changed();
    return result;
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '작업 응답을 확인하지 못했습니다. 실행을 반복하지 말고 현재 상태를 다시 조회해 주세요.',
      },
    };
  }
}
/** 최신 확인은 GET·환경 확인만 수행하며 AI를 실행하지 않습니다. */
export function inspectExistingAnalysis(
  scope: AnalysisExecutionScope,
  jobId: string,
): Promise<AnalysisExecutionInspectionResult> {
  return scoped(scope, (): Promise<AnalysisExecutionInspectionResult> =>
    analysisGateway.inspectExecution({
      connectionId: scope.connectionId,
      jobId,
    }),
  );
}
/** 사용자가 확인한 판본과 실행 의도를 명시적으로 전달합니다. */
export function executeExistingAnalysis(
  scope: AnalysisExecutionScope,
  request: Omit<AnalysisExecuteRequest, 'connectionId'>,
): Promise<AnalysisDetailResult> {
  return scoped(scope, (): Promise<AnalysisDetailResult> =>
    analysisGateway.execute({ ...request, connectionId: scope.connectionId }),
  );
}
/** 로컬 프로세스만 멈추며 서버 취소와 구분합니다. */
export function stopExistingAnalysis(
  scope: AnalysisExecutionScope,
  jobId: string,
): Promise<AnalysisDetailResult> {
  return scoped(scope, (): Promise<AnalysisDetailResult> =>
    analysisGateway.stopLocal({ connectionId: scope.connectionId, jobId }),
  );
}
