import { app, dialog, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { resolve, join } from 'node:path';
import {
  RUNTIME_CHANNELS,
  runtimeRequestSchema,
} from '@contracts/runtime.contract';
import type {
  RuntimePathKind,
  RuntimeResult,
} from '@contracts/runtime.contract';
import { RuntimeSettingsService } from '@main/settings/RuntimeSettingsService';
import { discoverBundledRuntime } from '@main/settings/bundledRuntime';
import { isAppSender } from './isAppSender';

/** 시작 시 설정을 한 번 적용하고 허용 창의 제한된 환경 작업만 연결합니다. */
export async function registerRuntimeHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
): Promise<void> {
  const bundled = await discoverBundledRuntime({
    packaged: app.isPackaged,
    platform: process.platform,
    architecture: process.arch,
    resourcesPath: process.resourcesPath,
  });
  const service = new RuntimeSettingsService(
    join(app.getPath('userData'), 'runtime-settings'),
    app.isPackaged ? '' : resolve(app.getAppPath(), '..'),
    async (kind: RuntimePathKind): Promise<string | null> => {
      const parent = getWindow();
      if (!parent) return null;
      const result = await dialog.showOpenDialog(parent, {
        title:
          kind === 'root'
            ? '문서 처리 프로그램 폴더 선택'
            : kind === 'tessdata'
              ? '문자 인식 언어 폴더 선택'
              : `${kind === 'python' ? 'Python' : kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : 'Tesseract'} 실행 파일 선택`,
        properties:
          kind === 'root' || kind === 'tessdata'
            ? ['openDirectory']
            : kind === 'python'
              ? ['openFile', 'showHiddenFiles']
              : ['openFile'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    bundled,
  );
  await service.initialize();
  ipcMain.handle(
    RUNTIME_CHANNELS.execute,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<RuntimeResult> => {
      if (!isAppSender(event, getWindow, rendererLocation))
        return {
          ok: false,
          error: { code: 'forbidden', message: '허용되지 않은 앱 요청입니다.' },
        };
      try {
        if (args.length !== 1) throw new Error('invalid_request');
        const request = runtimeRequestSchema.parse(args[0]);
        const data =
          request.operation === 'select-provider'
            ? (service.selectProvider(request.provider),
              await service.refreshConnection())
            : request.operation === 'select-model'
              ? await service.selectModel(request.provider, request.model)
              : request.operation === 'choose'
                ? await service.choose(request.kind)
                : request.operation === 'save'
                  ? await service.save()
                  : request.operation === 'diagnose'
                    ? await service.diagnose()
                    : request.operation === 'discover-cli'
                      ? await service.discoverCli()
                      : request.operation === 'connect-cli'
                        ? await service.connectCli()
                        : request.operation === 'check-cli-login'
                          ? await service.checkCliLogin()
                          : request.operation === 'cancel-cli-login'
                            ? service.cancelCliLogin()
                            : request.operation === 'test-ai'
                              ? await service.testAi()
                              : await service.refreshConnection();
        return { ok: true, data };
      } catch {
        return {
          ok: false,
          error: {
            code: 'runtime_settings_failed',
            message:
              '설정 변경을 완료하지 못했습니다. 실행 환경 경로와 다른 앱의 변경 여부를 확인해 주세요. 기존 설정은 보존했습니다.',
          },
        };
      }
    },
  );
}
