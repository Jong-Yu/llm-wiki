import type { App, BrowserWindow, Event } from 'electron';

export type AppLifetimeOptions = {
  activeCount: () => number;
  confirmQuit: (count: number) => Promise<boolean>;
  shutdown: () => Promise<void>;
};
/** 창 숨김과 실제 종료를 구분하며 승인한 종료는 실행 정리 뒤 한 번만 완료합니다. */
export function installAppLifetime(
  application: Pick<App, 'on' | 'quit'>,
  options: AppLifetimeOptions,
): (window: BrowserWindow) => void {
  let readyToQuit = false;
  let checkingQuit = false;
  application.on('before-quit', (event: Event): void => {
    if (readyToQuit) return;
    event.preventDefault();
    if (checkingQuit) return;
    checkingQuit = true;
    void (async (): Promise<void> => {
      try {
        const count = options.activeCount();
        if (count > 0 && !(await options.confirmQuit(count))) return;
        await options.shutdown();
        readyToQuit = true;
        application.quit();
      } finally {
        checkingQuit = false;
      }
    })().catch((): void => {
      /* 정리 실패 시 종료하지 않고 기존 창과 복구 기록을 유지합니다. */
    });
  });
  return (window: BrowserWindow): void => {
    window.on('close', (event: Event): void => {
      if (readyToQuit) return;
      event.preventDefault();
      window.hide();
    });
  };
}
