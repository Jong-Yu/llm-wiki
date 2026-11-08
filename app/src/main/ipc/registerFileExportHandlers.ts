import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  FILE_EXPORT_CHANNELS,
  desktopMarkdownExportRequestSchema,
} from '@contracts/fileExports.contract';
import type { MarkdownExportResult } from '@contracts/fileExports.contract';
import type { MarkdownExportService } from '@main/backend/MarkdownExportService';
import { isAppSender } from './isAppSender';

/** 정확한 앱 최상위 프레임과 제한된 본문만 파일 내보내기 서비스로 전달합니다. */
export function registerFileExportHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: Pick<MarkdownExportService, 'exportMarkdown'>,
): () => void {
  ipcMain.handle(
    FILE_EXPORT_CHANNELS.markdown,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<MarkdownExportResult> => {
      const current = (): boolean =>
        isAppSender(event, getWindow, rendererLocation);
      const parent = getWindow();
      if (!current() || !parent)
        return {
          ok: false,
          error: { code: 'forbidden', message: '허용되지 않은 앱 요청입니다.' },
        };
      const parsed =
        args.length === 1
          ? desktopMarkdownExportRequestSchema.safeParse(args[0])
          : null;
      if (!parsed?.success)
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: '내려받을 제목·본문과 작업 공간을 확인해 주세요.',
          },
        };
      return service.exportMarkdown(parsed.data, parent, current);
    },
  );
  return (): void => ipcMain.removeHandler(FILE_EXPORT_CHANNELS.markdown);
}
