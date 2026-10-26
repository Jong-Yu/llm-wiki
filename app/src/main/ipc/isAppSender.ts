import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { isRendererLocation } from '@main/windows/rendererLocation';

/** 앱의 정확한 최상위 문서에서 온 요청만 IPC를 사용할 수 있습니다. */
export function isAppSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
): boolean {
  const window = getWindow();
  return Boolean(
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isRendererLocation(event.senderFrame.url, rendererLocation),
  );
}
