import { BrowserWindow, screen } from 'electron';
import type {
  Event,
  WebContentsWillFrameNavigateEventParams,
  WebContentsWillRedirectEventParams,
  WindowOpenHandlerResponse,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { isRendererLocation } from './rendererLocation';

/** 창 수명과 탐색 경계만 관리하며 자료 서비스나 파일 저장을 시작하지 않습니다. */
export function createAppWindow(rendererLocation: string): BrowserWindow {
  // 작업 표시줄·Dock을 제외한 DIP 영역에 맞춰 작은 모니터에서도 창을 온전히 엽니다.
  const workArea = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint(),
  ).workArea;
  const width = Math.min(1920, workArea.width);
  const height = Math.min(1080, workArea.height);
  const window = new BrowserWindow({
    width,
    height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    minWidth: Math.min(960, workArea.width),
    minHeight: Math.min(640, workArea.height),
    title: 'LLM Wiki',
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.webContents.setWindowOpenHandler((): WindowOpenHandlerResponse => ({
    action: 'deny',
  }));
  window.webContents.on(
    'will-frame-navigate',
    (event: Event<WebContentsWillFrameNavigateEventParams>): void => {
      if (!isRendererLocation(event.url, rendererLocation))
        event.preventDefault();
    },
  );
  window.webContents.on(
    'will-redirect',
    (event: Event<WebContentsWillRedirectEventParams>, url: string): void => {
      if (!isRendererLocation(url, rendererLocation)) event.preventDefault();
    },
  );
  window.once('ready-to-show', (): void => window.show());
  return window;
}
