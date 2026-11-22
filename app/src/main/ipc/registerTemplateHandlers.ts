import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  TEMPLATES_CHANNELS,
  templateSessionSchema,
  templateChooseFileSchema,
  templateReadRequestSchema,
  templateSaveRequestSchema,
  templateArchiveRequestSchema,
  templateOriginalRequestSchema,
  templatePrepareResultRequestSchema,
  templateDownloadResultRequestSchema,
} from '@contracts/templates.contract';
import type { TemplateService } from '@main/backend/TemplateService';
import { isAppSender } from './isAppSender';

/** 허용된 앱 프레임에서만 파일 선택·고정판 생성 API를 호출합니다. */
export function registerTemplateHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: TemplateService,
): () => void {
  const operations = new Map<string, (value: unknown) => Promise<unknown>>([
    [
      TEMPLATES_CHANNELS.list,
      (value: unknown): Promise<unknown> =>
        service.list(templateSessionSchema.parse(value)),
    ],
    [
      TEMPLATES_CHANNELS.read,
      (value: unknown): Promise<unknown> =>
        service.read(templateReadRequestSchema.parse(value)),
    ],
    [
      TEMPLATES_CHANNELS.chooseFile,
      (value: unknown): Promise<unknown> =>
        service.chooseFile(
          templateChooseFileSchema.parse(value),
          getWindow() ?? undefined,
        ),
    ],
    [
      TEMPLATES_CHANNELS.save,
      (value: unknown): Promise<unknown> =>
        service.save(templateSaveRequestSchema.parse(value)),
    ],
    [
      TEMPLATES_CHANNELS.archive,
      (value: unknown): Promise<unknown> =>
        service.archive(templateArchiveRequestSchema.parse(value)),
    ],
    [
      TEMPLATES_CHANNELS.downloadOriginal,
      (value: unknown): Promise<unknown> =>
        service.downloadOriginal(
          templateOriginalRequestSchema.parse(value),
          getWindow() ?? undefined,
        ),
    ],
    [
      TEMPLATES_CHANNELS.prepareResult,
      (value: unknown): Promise<unknown> =>
        service.prepareResult(templatePrepareResultRequestSchema.parse(value)),
    ],
    [
      TEMPLATES_CHANNELS.downloadResult,
      (value: unknown): Promise<unknown> =>
        service.downloadResult(
          templateDownloadResultRequestSchema.parse(value),
          getWindow() ?? undefined,
        ),
    ],
  ]);
  for (const [channel, operation] of operations) {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<unknown> => {
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
              message: '템플릿 요청을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '템플릿 요청을 확인해 주세요. 입력 내용은 유지됩니다.',
            },
          };
        }
      },
    );
  }
  return (): void => {
    for (const channel of operations.keys()) ipcMain.removeHandler(channel);
  };
}
