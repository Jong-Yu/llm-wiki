import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  RESULT_DRAFT_CHANNELS,
  resultDraftRequestSchema,
} from '@contracts/resultDrafts.contract';
import type { ResultDraftResult } from '@contracts/resultDrafts.contract';
import type { ResultDraftService } from '@main/backend/ResultDraftService';
import { isAppSender } from './isAppSender';

/** 같은 창의 최상위 프레임에서 온 한정된 초안 요청만 main으로 전달합니다. */
export function registerResultDraftHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: ResultDraftService,
): () => void {
  ipcMain.handle(
    RESULT_DRAFT_CHANNELS.execute,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<ResultDraftResult> => {
      if (!isAppSender(event, getWindow, rendererLocation))
        return {
          ok: false,
          error: {
            code: 'forbidden',
            message: '허용되지 않은 창의 요청입니다.',
          },
        };
      const parsed =
        args.length === 1 ? resultDraftRequestSchema.safeParse(args[0]) : null;
      if (!parsed?.success)
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: '초안 요청 항목을 확인해 주세요.',
          },
        };
      return service.execute(parsed.data);
    },
  );
  return (): void => ipcMain.removeHandler(RESULT_DRAFT_CHANNELS.execute);
}
