import { ipcMain } from 'electron';
import { isAbsolute } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  ATTACHMENT_CHANNELS,
  attachmentDropIpcSchema,
  attachmentPickRequestSchema,
} from '@contracts/attachments.contract';
import type { AttachmentPickResult } from '@contracts/attachments.contract';
import type { AttachmentReader } from '@main/backend/AttachmentReader';
import { isAppSender } from './isAppSender';

/** 두 채널 모두 앱의 최상위 프레임만 허용합니다. drop의 경로는 격리된 preload가 채웁니다. */
export function registerAttachmentHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: Pick<AttachmentReader, 'pick' | 'drop'>,
): () => void {
  for (const channel of Object.values(ATTACHMENT_CHANNELS))
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<AttachmentPickResult> => {
        const parent = getWindow();
        if (!isAppSender(event, getWindow, rendererLocation) || !parent)
          return {
            ok: false,
            error: {
              code: 'forbidden',
              message: '허용되지 않은 앱 요청입니다.',
            },
          };
        if (args.length === 1) {
          if (channel === ATTACHMENT_CHANNELS.pick) {
            const parsed = attachmentPickRequestSchema.safeParse(args[0]);
            if (parsed.success) return service.pick(parent, parsed.data);
          } else {
            const parsed = attachmentDropIpcSchema.safeParse(args[0]);
            if (parsed.success && isAbsolute(parsed.data.path))
              return service.drop(parsed.data.path, {
                limit: parsed.data.limit,
              });
          }
        }
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: '첨부 요청의 입력을 확인해 주세요.',
          },
        };
      },
    );
  return (): void => {
    for (const channel of Object.values(ATTACHMENT_CHANNELS))
      ipcMain.removeHandler(channel);
  };
}
