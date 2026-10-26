import type {
  SourceDownloadRequest,
  SourceDownloadResult,
  SourcesBridge,
  SourceSessionRequest,
  SourceRegistrationRequest,
  SourceReceiptRequest,
  ChooseSourceFileResult,
  SourceRegistrationResult,
  SourceVersionsRequest,
  SourceVersionsResult,
} from '@contracts/sources.contract';

/** 원본 전송은 제한된 main bridge만 사용하고 renderer에 서버/파일 접근을 열지 않습니다. */
function getSourcesBridge(): SourcesBridge {
  if (!window.wiki?.sources) throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.sources;
}

export const sourcesGateway: SourcesBridge = {
  /** 검증한 원본의 저장 위치는 main의 OS 대화상자에서만 선택합니다. */
  download: async (
    request: SourceDownloadRequest,
  ): Promise<SourceDownloadResult> => getSourcesBridge().download(request),
  chooseFile: async (
    request: SourceSessionRequest,
  ): Promise<ChooseSourceFileResult> => getSourcesBridge().chooseFile(request),
  register: async (
    request: SourceRegistrationRequest,
  ): Promise<SourceRegistrationResult> => getSourcesBridge().register(request),
  receipt: async (
    request: SourceReceiptRequest,
  ): Promise<SourceRegistrationResult> => getSourcesBridge().receipt(request),
  versions: async (
    request: SourceVersionsRequest,
  ): Promise<SourceVersionsResult> => getSourcesBridge().versions(request),
};
