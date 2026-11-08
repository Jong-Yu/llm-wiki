import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '@contracts/update.contract';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type AppUpdater = {
  start: () => void;
  getStatus: () => UpdateStatus;
  /** 내려받은 업데이트가 있을 때만 앱을 종료하고 설치합니다. */
  install: () => boolean;
};

/** 설치된 앱만 GitHub Release의 최신 버전을 확인해 내려받고, 재시작 시 설치합니다. */
export function createAppUpdater(
  getWindow: () => BrowserWindow | null,
): AppUpdater {
  const { autoUpdater } = electronUpdater;
  let status: UpdateStatus = { state: 'idle' };

  const install = (): boolean => {
    if (status.state !== 'ready') return false;
    autoUpdater.quitAndInstall(true, true);
    return true;
  };

  const start = (): void => {
    // 개발 실행과 `--dir` 패키지는 업데이트 메타데이터가 없으므로 건너뜁니다.
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (error: unknown): void => {
      console.error('업데이트를 확인할 수 없습니다.', error);
    });
    autoUpdater.on('update-available', (info: { version: string }): void => {
      status = { state: 'downloading', version: info.version };
    });
    autoUpdater.on('update-not-available', (): void => {
      if (status.state !== 'ready') status = { state: 'idle' };
    });
    autoUpdater.on('update-downloaded', (info: { version: string }): void => {
      status = { state: 'ready', version: info.version };
      void (async (): Promise<void> => {
        const window = getWindow();
        const options = {
          type: 'info' as const,
          title: '업데이트 준비 완료',
          message: `새 버전 ${info.version}을 내려받았습니다.`,
          detail:
            '지금 재시작하면 설치합니다. 나중에 선택해도 사이드바의 업데이트 항목에서 설치할 수 있고, 앱을 종료할 때도 설치합니다.',
          buttons: ['지금 재시작', '나중에'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        };
        const result =
          window && !window.isDestroyed()
            ? await dialog.showMessageBox(window, options)
            : await dialog.showMessageBox(options);
        if (result.response === 0) install();
      })();
    });
    const check = (): void => {
      autoUpdater.checkForUpdates().catch((error: unknown): void => {
        console.error('업데이트를 확인할 수 없습니다.', error);
      });
    };
    check();
    setInterval(check, CHECK_INTERVAL_MS).unref();
  };

  return { start, getStatus: (): UpdateStatus => status, install };
}
