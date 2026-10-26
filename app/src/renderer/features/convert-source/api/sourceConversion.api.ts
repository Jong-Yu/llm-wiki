import type {
  SourceConversionReadRequest,
  SourceConversionStartRequest,
  SourceConversionCancelRequest,
  SourceConversionResult,
} from '@contracts/sourceConversion.contract';
import { sourceConversionGateway } from '@renderer/platform/sourceConversion';

/** 통신 실패를 변환/저장 실패로 단정하지 않고 조회로 확인합니다. */
function unavailable(): SourceConversionResult {
  return {
    ok: false,
    error: {
      code: 'conversion_unavailable',
      message:
        '변환 상태를 읽지 못했습니다. 상태 확인으로 진행 중인 요청을 다시 조회해 주세요.',
    },
  };
}
/** 명시한 한 요청으로만 개인 변환기를 시작합니다. */
export async function startSourceConversion(
  request: SourceConversionStartRequest,
): Promise<SourceConversionResult> {
  try {
    return await sourceConversionGateway.start(request);
  } catch {
    return unavailable();
  }
}
/** 조회는 개인 변환기 실행이나 보고 재전송을 요청하지 않습니다. */
export async function readSourceConversion(
  request: SourceConversionReadRequest,
): Promise<SourceConversionResult> {
  try {
    return await sourceConversionGateway.read(request);
  } catch {
    return unavailable();
  }
}
/** 저장된 원본/보고를 삭제하지 않는 로컬 실행 취소를 요청합니다. */
export async function cancelSourceConversion(
  request: SourceConversionCancelRequest,
): Promise<SourceConversionResult> {
  try {
    return await sourceConversionGateway.cancel(request);
  } catch {
    return unavailable();
  }
}
