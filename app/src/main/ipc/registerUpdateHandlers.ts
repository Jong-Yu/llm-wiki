import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { UPDATE_CHANNELS } from '@contracts/update.contract';
import type { UpdateResult } from '@contracts/update.contract';
import type { AppUpdater } from '@main/updates/AppUpdater';
import { isAppSender } from './isAppSender';

const FORBIDDEN: UpdateResult = {
  ok: false,
  error: { code: 'forbidden', message: '허용되지 않은 앱 요청입니다.' },
};
const NO_ARGUMENTS: UpdateResult = {
  ok: false,
  error: {
    code: 'invalid_request',
    message: '업데이트 요청은 인자를 받지 않습니다.',
  },
};

/** 정확한 앱 프레임의 무인자 요청만 업데이트 상태 조회·설치로 전달합니다. */
export function registerUpdateHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  updater: Pick<AppUpdater, 'getStatus' | 'install'>,
): void {
  ipcMain.handle(
    UPDATE_CHANNELS.status,
    (event: IpcMainInvokeEvent, ...args: unknown[]): UpdateResult => {
      if (!isAppSender(event, getWindow, rendererLocation)) return FORBIDDEN;
      if (args.length !== 0) return NO_ARGUMENTS;
      return { ok: true, data: updater.getStatus() };
    },
  );
  ipcMain.handle(
    UPDATE_CHANNELS.install,
    (event: IpcMainInvokeEvent, ...args: unknown[]): UpdateResult => {
      if (!isAppSender(event, getWindow, rendererLocation)) return FORBIDDEN;
      if (args.length !== 0) return NO_ARGUMENTS;
      if (!updater.install()) {
        return {
          ok: false,
          error: {
            code: 'not_ready',
            message: '설치할 수 있는 업데이트가 없습니다.',
          },
        };
      }
      return { ok: true, data: updater.getStatus() };
    },
  );
}
