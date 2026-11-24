import { app, BrowserWindow, dialog, session } from 'electron';
import { installAppLifetime, showAppWindow } from './windows/appLifetime';
import type { Event, WebContents } from 'electron';
import appIcon from '../../design/brand/llm-wiki-icon.png?asset';
import appDarkIcon from '../../design/brand/llm-wiki-icon-dark.png?asset';
import windowsIcon from '../../design/brand/llm-wiki-icon.ico?asset';
import windowsDarkIcon from '../../design/brand/llm-wiki-icon-dark.ico?asset';
import { registerRuntimeHandlers } from './ipc/registerRuntimeHandlers';
import { registerAppHandlers } from './ipc/registerAppHandlers';
import { registerConnectionHandlers } from './ipc/registerConnectionHandlers';
import { createAppWindow } from './windows/createAppWindow';
import { createAppTray } from './windows/createAppTray';
import { watchSystemIconTheme } from './windows/watchSystemIconTheme';
import { getRendererLocation } from './windows/rendererLocation';
import { createAppUpdater } from './updates/AppUpdater';
import { registerUpdateHandlers } from './ipc/registerUpdateHandlers';

/** Electron 시작·종료와 창/IPC 조립의 진입점입니다. */
async function startApp(): Promise<void> {
  // Windows 알림의 앱 식별자를 설치 패키지 appId와 맞춥니다.
  if (process.platform === 'win32')
    app.setAppUserModelId('local.llm-wiki.desktop');
  await app.whenReady();
  // 실행 중 Dock은 시스템 테마를 따르며 Finder의 정적 번들 아이콘은 별도입니다.
  if (process.platform === 'darwin') {
    const stopTheme = watchSystemIconTheme((dark: boolean): void => {
      app.dock?.setIcon(dark ? appDarkIcon : appIcon);
    });
    app.once('will-quit', stopTheme);
  }
  // 명시한 외부 환경의 별칭을 맞춥니다. 설치 패키지의 기본 환경은 설정 초기화에서 선택합니다.
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
  const updater = createAppUpdater((): BrowserWindow | null => window);
  registerUpdateHandlers(
    (): BrowserWindow | null => window,
    rendererLocation,
    updater,
  );
  const clearConnection = await registerConnectionHandlers(
    (): BrowserWindow | null => window,
    rendererLocation,
  );
  const attachLifetime = installAppLifetime(app, {
    activeCount: clearConnection.activeCount,
    confirmQuit: async (count: number): Promise<boolean> => {
      // 숨긴 창에서 종료를 요청해도 확인 창을 바로 볼 수 있게 합니다.
      if (window) showAppWindow(window);
      const options = {
        type: 'question' as const,
        title: '진행 중인 AI 작업',
        message: `${count}개의 작업이 진행 또는 접수 중입니다.`,
        detail:
          '종료하면 실행을 중단하고 저장된 결과와 복구 기록은 보존합니다. 계속 실행하려면 창을 닫아 숨길 수 있습니다.',
        buttons: ['계속 실행', '작업을 중단하고 종료'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    },
    shutdown: clearConnection,
  });

  /** 창 닫기는 숨김이며 연결과 실행은 명시 종료까지 유지합니다. */
  const openWindow = (): void => {
    window = createAppWindow(rendererLocation);
    attachLifetime(window);
    window.on('closed', (): void => {
      window = null;
    });
    void window.loadURL(rendererLocation).catch((error: unknown): void => {
      console.error('앱 화면을 열 수 없습니다.', error);
      app.quit();
    });
  };
  /** 트레이와 OS의 재열기는 같은 창과 진행 중인 작업을 유지합니다. */
  const showWindow = (): void => {
    if (!window || window.isDestroyed()) openWindow();
    else showAppWindow(window);
  };
  openWindow();
  if (process.platform === 'win32') {
    createAppTray(app, {
      iconPath: windowsIcon,
      darkIconPath: windowsDarkIcon,
      showWindow,
    });
  }
  updater.start();
  app.on('activate', showWindow);
}

app.on('window-all-closed', (): void => {
  if (process.platform !== 'darwin') app.quit();
});

// 같은 사용자 설정 경로를 두 프로세스가 동시에 갱신하지 않습니다.
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (): void => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) showAppWindow(existing);
  });
  void startApp().catch((error: unknown): void => {
    console.error('앱을 시작할 수 없습니다.', error);
    app.quit();
  });
} else {
  app.quit();
}
