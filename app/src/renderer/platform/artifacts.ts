import type {
  ArtifactsBridge,
  ChooseArtifactFileRequest,
  ChooseArtifactFileResult,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactDownloadRequest,
  ArtifactDownloadResult,
} from '@contracts/artifacts.contract';

/** 경로·바이트는 main에 두고 명시한 파일 전송 동작만 사용합니다. */
function getArtifactsBridge(): ArtifactsBridge {
  if (!window.wiki?.artifacts)
    throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.artifacts;
}
export const artifactsGateway: ArtifactsBridge = {
  chooseFile: async (
    request: ChooseArtifactFileRequest,
  ): Promise<ChooseArtifactFileResult> =>
    getArtifactsBridge().chooseFile(request),
  upload: async (
    request: ArtifactUploadRequest,
  ): Promise<ArtifactUploadResult> => getArtifactsBridge().upload(request),
  download: async (
    request: ArtifactDownloadRequest,
  ): Promise<ArtifactDownloadResult> => getArtifactsBridge().download(request),
};
