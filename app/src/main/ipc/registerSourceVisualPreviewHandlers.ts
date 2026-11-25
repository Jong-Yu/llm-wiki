import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  SOURCE_VISUAL_PREVIEW_CHANNELS,
  sourceVisualPreviewRequestSchema,
  sourceVisualPreviewReleaseSchema,
  sourceVisualPreviewResultSchema,
  sourceVisualPreviewReleaseResultSchema,
} from '@contracts/sourceVisualPreviews.contract';
import type {
  SourceVisualPreviewResult,
  SourceVisualPreviewReleaseResult,
} from '@contracts/sourceVisualPreviews.contract';
import type { SourceVisualPreviewService } from '@main/backend/SourceVisualPreviewService';
import { isAppSender } from './isAppSender';

/** 최상위 앱 창의 검증된 미리보기 요청만 현재 범위의 임시 파일에 접근합니다. */
export function registerSourceVisualPreviewHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: SourceVisualPreviewService,
): void {
  type Result = SourceVisualPreviewResult | SourceVisualPreviewReleaseResult;
  const register = (
    channel: string,
    operation: (value: unknown) => Promise<Result>,
  ): void => {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<Result> => {
        if (!isAppSender(event, getWindow, rendererLocation))
          return {
            ok: false,
            error: {
              code: 'forbidden',
              message: '허용되지 않은 앱 요청입니다.',
            },
          };
        if (args.length !== 1)
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '원본 미리보기 요청을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'source_preview_failed',
              message: '원본 미리보기를 표시하지 못했습니다.',
            },
          };
        }
      },
    );
  };
  register(
    SOURCE_VISUAL_PREVIEW_CHANNELS.read,
    async (value: unknown): Promise<SourceVisualPreviewResult> =>
      sourceVisualPreviewResultSchema.parse(
        await service.read(sourceVisualPreviewRequestSchema.parse(value)),
      ),
  );
  register(
    SOURCE_VISUAL_PREVIEW_CHANNELS.release,
    async (value: unknown): Promise<SourceVisualPreviewReleaseResult> =>
      sourceVisualPreviewReleaseResultSchema.parse(
        await service.release(
          sourceVisualPreviewReleaseSchema.parse(value).previewId,
        ),
      ),
  );
}
