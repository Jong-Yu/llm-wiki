import type {
  SourceVisualPreviewRequest,
  SourceVisualPreviewResult,
  SourceVisualPreviewReleaseRequest,
  SourceVisualPreviewReleaseResult,
  SourceVisualPreviewsBridge,
} from '@contracts/sourceVisualPreviews.contract';

/** 로컬 원본 미리보기의 좁은 bridge만 feature에 공개합니다. */
export const sourceVisualPreviewsGateway: SourceVisualPreviewsBridge = {
  read: async (
    request: SourceVisualPreviewRequest,
  ): Promise<SourceVisualPreviewResult> => {
    if (!window.wiki?.sourceVisualPreviews)
      return {
        ok: false,
        error: {
          code: 'preview_unavailable',
          message: '원본 미리보기는 최신 데스크톱 앱에서 확인해 주세요.',
        },
      };
    return window.wiki.sourceVisualPreviews.read(request);
  },
  release: async (
    request: SourceVisualPreviewReleaseRequest,
  ): Promise<SourceVisualPreviewReleaseResult> =>
    window.wiki?.sourceVisualPreviews?.release(request) ?? { ok: true },
};
