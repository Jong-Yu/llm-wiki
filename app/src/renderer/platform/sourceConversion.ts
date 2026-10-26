import type {
  SourceConversionBridge,
  SourceConversionStartRequest,
  SourceConversionReadRequest,
  SourceConversionCancelRequest,
  SourceConversionResult,
} from '@contracts/sourceConversion.contract';

/** 현재 창의 제한된 작업 bridge만 선택하고 실행 경로와 인증은 main에 둡니다. */
function getBridge(): SourceConversionBridge {
  if (!window.wiki?.sourceConversion)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.sourceConversion;
}
export const sourceConversionGateway: SourceConversionBridge = {
  start: async (
    request: SourceConversionStartRequest,
  ): Promise<SourceConversionResult> => getBridge().start(request),
  read: async (
    request: SourceConversionReadRequest,
  ): Promise<SourceConversionResult> => getBridge().read(request),
  cancel: async (
    request: SourceConversionCancelRequest,
  ): Promise<SourceConversionResult> => getBridge().cancel(request),
};
