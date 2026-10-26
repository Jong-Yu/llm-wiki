import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  RECOVERY_CHANNELS,
  recoveryRequestSchema,
} from '@contracts/recovery.contract';
import type { RecoveryResult } from '@contracts/recovery.contract';
import type { RecoveryService } from '@main/backend/RecoveryService';
import { isAppSender } from './isAppSender';
/** 현재 앱 최상위 프레임의 제한된 복구 명령만 허용합니다. */
export function registerRecoveryHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: RecoveryService,
): () => void {
  ipcMain.handle(
    RECOVERY_CHANNELS.execute,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<RecoveryResult> => {
      if (!isAppSender(event, getWindow, rendererLocation))
        return {
          ok: false,
          error: { code: 'forbidden', message: '허용되지 않은 창입니다.' },
        };
      const parsed =
        args.length === 1 ? recoveryRequestSchema.safeParse(args[0]) : null;
      if (!parsed?.success)
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: '복구 요청 항목을 확인해 주세요.',
          },
        };
      return service.execute(parsed.data);
    },
  );
  return (): void => ipcMain.removeHandler(RECOVERY_CHANNELS.execute);
}
