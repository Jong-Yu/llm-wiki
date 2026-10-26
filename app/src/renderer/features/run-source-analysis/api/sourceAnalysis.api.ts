import type { ConnectionResult } from '@contracts/connection.contract';
import type {
  AnalysisDetailResult,
  AnalysisPageResult,
  AnalysisStartRequest,
} from '@contracts/analysis.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { analysisGateway } from '@renderer/platform/analysis';
import type {
  AnalysisSourceSelection,
  AnalysisError,
} from '../model/analysis.types';

/** 연결·사용자·공간·관점이 하나라도 달라지면 이전 원본의 결과를 현재 화면에 섞지 않습니다. */
function sameSelection(
  result: ConnectionResult,
  source: AnalysisSourceSelection,
): boolean {
  if (!result.ok || result.data.status !== 'connected') return false;
  const connection = result.data;
  return (
    connection.connectionId === source.connectionId &&
    connection.userId === source.scope.userId &&
    connection.policyRevision === source.scope.policyRevision &&
    connection.selection?.tenant === source.scope.tenant &&
    connection.selection.profile === source.scope.profileId
  );
}

/** 연결 범위가 바뀐 실패는 새로 연결할 때까지 이전 결과를 숨기는 신호로 사용합니다. */
function changedScope(): { ok: false; error: AnalysisError } {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결이나 작업 공간·관점이 변경되었습니다. 창을 닫고 현재 원본에서 다시 열어 주세요.',
    },
  };
}

/** 전송 전후 현재 범위를 확인하고 예외에 비밀 정보가 있어도 고정 안내로 바꿉니다. */
async function inCurrentScope<
  T extends AnalysisDetailResult | AnalysisPageResult,
>(
  source: AnalysisSourceSelection,
  operation: () => Promise<T>,
): Promise<T | { ok: false; error: AnalysisError }> {
  try {
    if (!sameSelection(await connectionGateway.getState(), source))
      return changedScope();
    const result = await operation();
    if (!sameSelection(await connectionGateway.getState(), source))
      return changedScope();
    return result;
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '분석 상태를 확인하지 못했습니다. 서버 연결을 확인한 뒤 결과를 다시 조회해 주세요.',
      },
    };
  }
}

/** 이 원본의 기존 작업만 읽으며 목록 조회 자체는 분석을 실행하지 않습니다. */
export async function listSourceAnalysis(
  source: AnalysisSourceSelection,
  cursor: string | null,
): Promise<AnalysisPageResult> {
  return inCurrentScope(source, (): Promise<AnalysisPageResult> =>
    analysisGateway.list({
      connectionId: source.connectionId,
      sourceId: source.sourceId,
      cursor,
    }),
  );
}

/** 사용자가 확인한 원본 판본·대상·결과 종류를 한 번만 제출합니다. 자동 재전송하지 않습니다. */
export async function startSourceAnalysis(
  source: AnalysisSourceSelection,
  targetDocument: string,
  outputs: AnalysisStartRequest['outputs'],
): Promise<AnalysisDetailResult> {
  return inCurrentScope(source, (): Promise<AnalysisDetailResult> =>
    analysisGateway.start({
      connectionId: source.connectionId,
      sourceId: source.sourceId,
      sourceVersion: source.sourceVersion,
      sourceSha256: source.sourceSha256,
      registrationRevision: source.registrationRevision,
      targetDocument,
      outputs,
    }),
  );
}

/** 저장 여부는 CLI 출력이 아닌 서버 작업·영수증 조회에서 확인합니다. */
export async function readSourceAnalysis(
  source: AnalysisSourceSelection,
  jobId: string,
): Promise<AnalysisDetailResult> {
  return inCurrentScope(source, (): Promise<AnalysisDetailResult> =>
    analysisGateway.read({ connectionId: source.connectionId, jobId }),
  );
}

/** 현재 조회한 작업 판본으로만 취소하며 이미 저장된 결과는 그대로 둡니다. */
export async function cancelSourceAnalysis(
  source: AnalysisSourceSelection,
  jobId: string,
  expectedJobRevision: string,
): Promise<AnalysisDetailResult> {
  return inCurrentScope(source, (): Promise<AnalysisDetailResult> =>
    analysisGateway.cancel({
      connectionId: source.connectionId,
      jobId,
      expectedJobRevision,
    }),
  );
}
