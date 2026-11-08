import { BrowserWindow, screen, shell } from 'electron';
import type {
  Event,
  WebContentsWillFrameNavigateEventParams,
  WebContentsWillRedirectEventParams,
  WindowOpenHandlerResponse,
  HandlerDetails,
} from 'electron';
import { fileURLToPath } from 'node:url';
import appIcon from '../../../design/brand/llm-wiki-icon.png?asset';
import windowsIcon from '../../../design/brand/llm-wiki-icon.ico?asset';
import { isRendererLocation, isWindowFrameLocation } from './rendererLocation';
import { isPublicWebUrl } from '@contracts/webEvidence.contract';

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
    icon: process.platform === 'win32' ? windowsIcon : appIcon,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.webContents.setWindowOpenHandler(
    (details: HandlerDetails): WindowOpenHandlerResponse => {
      // 웹 근거의 명시 링크는 기본 브라우저에 열고 앱 창의 외부 탐색은 계속 막습니다.
      if (
        isRendererLocation(window.webContents.getURL(), rendererLocation) &&
        isPublicWebUrl(details.url)
      )
        void shell.openExternal(details.url).catch((): void => {});
      return { action: 'deny' };
    },
  );
  window.webContents.on(
    'will-frame-navigate',
    (event: Event<WebContentsWillFrameNavigateEventParams>): void => {
      if (
        !isWindowFrameLocation(event.url, rendererLocation, event.isMainFrame)
      )
        event.preventDefault();
    },
  );
  window.webContents.on(
    'will-redirect',
    (event: Event<WebContentsWillRedirectEventParams>, url: string): void => {
      if (!isWindowFrameLocation(url, rendererLocation, event.isMainFrame))
        event.preventDefault();
    },
  );
  window.once('ready-to-show', (): void => window.show());
  return window;
}
