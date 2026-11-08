import { sameAccessRevision } from '@contracts/connection.contract';
import type { ConnectionResult } from '@contracts/connection.contract';
import type {
  SourceConversionScope,
  SourceConversionResult,
  ConversionSource,
} from '@contracts/sourceConversion.contract';
import type {
  AnalysisStartRequest,
  AnalysisDetailResult,
  AnalysisExecutionInspectionResult,
} from '@contracts/analysis.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { sourceConversionGateway } from '@renderer/platform/sourceConversion';
import { analysisGateway } from '@renderer/platform/analysis';
import type {
  ImportProcessingApi,
  ImportProcessingError,
  ImportProcessingResult,
} from '../model/importProcessing.types';

/** 현재 연결의 주체·공간·관점·정책을 고정 입력과 대조합니다. */
function sameScope(
  scope: SourceConversionScope,
  result: ConnectionResult,
): boolean {
  return (
    result.ok &&
    result.data.status === 'connected' &&
    result.data.connectionId === scope.connectionId &&
    result.data.userId === scope.userId &&
    sameAccessRevision(result.data, scope) &&
    result.data.selection?.tenant === scope.tenant &&
    result.data.selection.profile === scope.profileId
  );
}
/** 범위가 변경되면 이전 본문과 작업 실행을 숨기는 신호를 반환합니다. */
function scopeError(): ImportProcessingError {
  return {
    code: 'scope_changed',
    message:
      '연결·사용자·작업 공간이 변경되었습니다. 원래 입력과 처리 기록은 보존했습니다. 현재 연결을 다시 확인해 주세요.',
  };
}
/** 전송 전후 범위를 검증하며 쓰기의 불확실한 결과는 자동 재전송하지 않습니다. */
async function scoped<T>(
  scope: SourceConversionScope,
  mutation: boolean,
  operation: () => Promise<ImportProcessingResult<T>>,
): Promise<ImportProcessingResult<T>> {
  let sent = false;
  try {
    if (!sameScope(scope, await connectionGateway.getState()))
      return { ok: false, error: { ...scopeError(), notSent: true } };
    sent = true;
    const result = await operation();
    if (!sameScope(scope, await connectionGateway.getState())) {
      return {
        ok: false,
        error: {
          ...scopeError(),
          ...(!result.ok && result.error.recovery
            ? { recovery: result.error.recovery }
            : {}),
        },
      };
    }
    return result;
  } catch {
    return {
      ok: false,
      error: {
        code: mutation ? 'outcome_unknown' : 'bridge_unavailable',
        notSent: !sent,
        message: mutation
          ? '전송 결과를 확인하지 못했습니다. 같은 요청을 다시 보내지 않고 저장 상태를 확인해 주세요.'
          : '처리 상태를 읽지 못했습니다. 원본과 확인된 결과는 보존했습니다.',
      },
    };
  }
}
/** renderer의 연결 ID는 인증이 아니며 기대 범위는 main 검증에만 사용합니다. */
function expectedScope(
  scope: SourceConversionScope,
): Omit<SourceConversionScope, 'connectionId'> {
  return {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
    ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
  };
}

/** 등록 원본과 변환 보고를 새 단일 Markdown 접수 계약으로 연결합니다. */
export const importProcessingApi: ImportProcessingApi = {
  conversionRead: (
    scope: SourceConversionScope,
    source: ConversionSource,
  ): Promise<SourceConversionResult> =>
    scoped(scope, false, (): Promise<SourceConversionResult> =>
      sourceConversionGateway.read({
        ...source,
        connectionId: scope.connectionId,
        expectedScope: expectedScope(scope),
      }),
    ),
  conversionStart: (
    scope: SourceConversionScope,
    source: ConversionSource,
  ): Promise<SourceConversionResult> =>
    scoped(scope, true, (): Promise<SourceConversionResult> =>
      sourceConversionGateway.start({
        ...source,
        connectionId: scope.connectionId,
        expectedScope: expectedScope(scope),
        ocr: 'auto',
        ocrLanguage: 'kor+eng',
      }),
    ),
  register: (
    scope: SourceConversionScope,
    request: AnalysisStartRequest,
  ): Promise<AnalysisDetailResult> =>
    scoped(scope, true, (): Promise<AnalysisDetailResult> =>
      analysisGateway.start(request),
    ),
  inspectJob: (
    scope: SourceConversionScope,
    jobId: string,
  ): Promise<AnalysisExecutionInspectionResult> =>
    scoped(scope, false, (): Promise<AnalysisExecutionInspectionResult> =>
      analysisGateway.inspectExecution({
        connectionId: scope.connectionId,
        jobId,
      }),
    ),
  executeJob: (
    scope: SourceConversionScope,
    jobId: string,
    expectedJobRevision: string,
    mode: 'start' | 'resume',
  ): Promise<AnalysisDetailResult> =>
    scoped(scope, true, (): Promise<AnalysisDetailResult> =>
      analysisGateway.execute({
        connectionId: scope.connectionId,
        jobId,
        expectedJobRevision,
        mode,
      }),
    ),
};
