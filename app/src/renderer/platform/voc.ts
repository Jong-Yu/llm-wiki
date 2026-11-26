import type {
  VocSubmitRequest,
  VocSubmitResult,
} from '@contracts/voc.contract';

/** 오류 보고 전송만 공개하고 인증 정보는 main에 둡니다. */
export async function submitErrorReport(
  request: VocSubmitRequest,
): Promise<VocSubmitResult> {
  if (!window.wiki?.voc)
    throw new Error('오류 보고를 지원하는 최신 앱에서 실행해 주세요.');
  return window.wiki.voc.submit(request);
}
