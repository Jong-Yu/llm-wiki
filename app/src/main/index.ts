import { app, BrowserWindow, session } from 'electron';
import type { Event, WebContents } from 'electron';
import { registerRuntimeHandlers } from './ipc/registerRuntimeHandlers';
import { registerAppHandlers } from './ipc/registerAppHandlers';
import { registerConnectionHandlers } from './ipc/registerConnectionHandlers';
import { createAppWindow } from './windows/createAppWindow';
import { getRendererLocation } from './windows/rendererLocation';

/** Electron 시작·종료와 창/IPC 조립의 진입점입니다. */
async function startApp(): Promise<void> {
  await app.whenReady();
  // 패키지 안에 Python/자료를 넣지 않고 설치된 개인 실행 환경을 모든 실행기에 동일하게 전달합니다.
  const clientRoot =
    process.env.WIKI_CLIENT_ROOT || process.env.WIKI_ANALYSIS_PROJECT_ROOT;
  const clientPython =
    process.env.WIKI_PYTHON ||
    process.env.WIKI_CLIENT_PYTHON ||
    process.env.WIKI_ANALYSIS_PYTHON;
  if (clientRoot) {
    process.env.WIKI_CLIENT_ROOT = clientRoot;
    process.env.WIKI_ANALYSIS_PROJECT_ROOT = clientRoot;
  }
  if (clientPython) {
    process.env.WIKI_PYTHON = clientPython;
    process.env.WIKI_CLIENT_PYTHON = clientPython;
    process.env.WIKI_ANALYSIS_PYTHON = clientPython;
  }
  const rendererLocation = getRendererLocation();
  let window: BrowserWindow | null = null;

  session.defaultSession.setPermissionRequestHandler(
    (
      _contents: WebContents,
      _permission: string,
      respond: (allowed: boolean) => void,
    ): void => respond(false),
  );
  session.defaultSession.setPermissionCheckHandler((): boolean => false);
  session.defaultSession.on('will-download', (event: Event): void =>
    event.preventDefault(),
  );
  await registerRuntimeHandlers(
    (): BrowserWindow | null => window,
    rendererLocation,
  );
  registerAppHandlers((): BrowserWindow | null => window, rendererLocation);
  const clearConnection = await registerConnectionHandlers(
    (): BrowserWindow | null => window,
    rendererLocation,
  );
  let readyToQuit = false;
  // Python이 자기 AI 자식과 임시 인증 파일을 정리한 뒤 앱을 종료합니다.
  app.on('before-quit', (event: Event): void => {
    if (readyToQuit) return;
    event.preventDefault();
    void clearConnection().finally((): void => {
      readyToQuit = true;
      app.quit();
    });
  });

  /** 새 창을 열고 닫힐 때 해당 창의 연결 자격 증명을 해제합니다. */
  const openWindow = (): void => {
    window = createAppWindow(rendererLocation);
    window.on('closed', (): void => {
      void clearConnection();
      window = null;
    });
    void window.loadURL(rendererLocation).catch((error: unknown): void => {
      console.error('앱 화면을 열 수 없습니다.', error);
      app.quit();
    });
  };
  openWindow();
  app.on('activate', (): void => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}

app.on('window-all-closed', (): void => {
  if (process.platform !== 'darwin') app.quit();
});

// 같은 사용자 설정 경로를 두 프로세스가 동시에 갱신하지 않습니다.
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (): void => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing?.isMinimized()) existing.restore();
    existing?.focus();
  });
  void startApp().catch((error: unknown): void => {
    console.error('앱을 시작할 수 없습니다.', error);
    app.quit();
  });
} else {
  app.quit();
}
