import { app, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/app.contract';
import type { GetAppInfoResult } from '@contracts/app.contract';
import { isAppSender } from './isAppSender';

/** 호출 창·최상위 프레임·정확한 문서와 무인자 요청을 모두 확인합니다. */
export function registerAppHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
): void {
  ipcMain.handle(
    IPC_CHANNELS.appGetInfo,
    (event: IpcMainInvokeEvent, ...args: unknown[]): GetAppInfoResult => {
      if (!isAppSender(event, getWindow, rendererLocation)) {
        return {
          ok: false,
          error: { code: 'forbidden', detail: '허용되지 않은 앱 요청입니다.' },
        };
      }
      if (args.length !== 0) {
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            detail: '앱 정보 요청은 인자를 받지 않습니다.',
          },
        };
      }
      return {
        ok: true,
        data: {
          name: 'LLM Wiki',
          version: app.getVersion(),
          electronVersion: process.versions.electron,
          platform: process.platform,
        },
      };
    },
  );
}
