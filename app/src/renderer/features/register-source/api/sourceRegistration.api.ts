import type {
  ChooseSourceFileResult,
  SourceRegistrationRequest,
  SourceRegistrationResult,
  SourceReceiptRequest,
  SourceSessionRequest,
} from '@contracts/sources.contract';
import { sourcesGateway } from '@renderer/platform/sources';

/** native 파일 선택 실패는 원격 등록 실패와 구분합니다. */
export async function chooseSourceFile(
  request: SourceSessionRequest,
): Promise<ChooseSourceFileResult> {
  try {
    return await sourcesGateway.chooseFile(request);
  } catch {
    return {
      ok: false,
      error: {
        code: 'file_unavailable',
        message: '파일 선택을 완료하지 못했습니다. 다시 선택해 주세요.',
      },
    };
  }
}

/** 전송 결과를 읽지 못하면 자동 재등록하지 않고 같은 요청의 확인을 요구합니다. */
export async function registerSource(
  request: SourceRegistrationRequest,
): Promise<SourceRegistrationResult> {
  try {
    return await sourcesGateway.register(request);
  } catch {
    return unknownRegistration();
  }
}

/** 본인 요청 영수증만 재조회하며 POST를 반복하지 않습니다. */
export async function checkSourceReceipt(
  request: SourceReceiptRequest,
): Promise<SourceRegistrationResult> {
  try {
    return await sourcesGateway.receipt(request);
  } catch {
    return unknownRegistration();
  }
}

/** 원격 본문이나 예외 내용을 그대로 노출하지 않습니다. */
function unknownRegistration(): SourceRegistrationResult {
  return {
    ok: false,
    error: {
      code: 'outcome_unknown',
      message:
        '등록 결과를 확인하지 못했습니다. 등록 상태 확인으로 같은 요청을 다시 확인해 주세요.',
    },
  };
}
