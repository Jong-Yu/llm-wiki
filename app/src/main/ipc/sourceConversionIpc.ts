import type { RecoveryService } from '@main/backend/RecoveryService';
import { app, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import {
  SOURCE_CONVERSION_CHANNELS,
  sourceConversionStartSchema,
  sourceConversionReadSchema,
  sourceConversionCancelSchema,
  parseSourceConversionResult,
} from '@contracts/sourceConversion.contract';
import type { SourceConversionResult } from '@contracts/sourceConversion.contract';
import { SourceConversionService } from '@main/backend/SourceConversionService';
import type { ConnectionService } from '@main/backend/ConnectionService';
import { isAppSender } from './isAppSender';

/** 기존 연결 인스턴스와 허용 창을 재사용하며 셸/파일 경로 입력을 열지 않습니다. */
export function registerSourceConversionHandlers(
  connection: ConnectionService,
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  recovery?: RecoveryService,
): () => Promise<void> {
  const service = new SourceConversionService(
    connection,
    {
      workRoot: join(app.getPath('userData'), 'source-conversions'),
    },
    recovery,
  );
  /** 채널별 요청 검사 전에 sender와 인자 개수를 확인합니다. */
  const register = (
    channel: string,
    operation: (value: unknown) => Promise<SourceConversionResult>,
  ): void => {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<SourceConversionResult> => {
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
              message: '변환 요청 입력을 확인해 주세요.',
            },
          };
        try {
          return parseSourceConversionResult(await operation(args[0]));
        } catch {
          return {
            ok: false,
            error: {
              code: 'conversion_unavailable',
              message:
                '변환 상태를 확인할 수 없습니다. 상태를 다시 조회해 주세요.',
            },
          };
        }
      },
    );
  };
  register(
    SOURCE_CONVERSION_CHANNELS.start,
    (value: unknown): Promise<SourceConversionResult> =>
      service.start(sourceConversionStartSchema.parse(value)),
  );
  register(
    SOURCE_CONVERSION_CHANNELS.read,
    (value: unknown): Promise<SourceConversionResult> =>
      service.read(sourceConversionReadSchema.parse(value)),
  );
  register(
    SOURCE_CONVERSION_CHANNELS.cancel,
    (value: unknown): Promise<SourceConversionResult> =>
      service.cancel(sourceConversionCancelSchema.parse(value)),
  );
  return (): Promise<void> => service.stop();
}
