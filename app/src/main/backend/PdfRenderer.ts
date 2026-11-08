import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { markdownToHtmlFile, ConversionFailed } from './DocumentConverter';

/**
 * Markdown을 HTML로 바꾼 뒤 숨은 창에서 PDF로 인쇄합니다.
 * 창은 스크립트·네트워크를 쓰지 못하고 이번 임시 HTML 하나만 열 수 있습니다.
 */
export async function markdownToPdf(
  content: string,
  title: string,
): Promise<Uint8Array> {
  const { BrowserWindow, session } = await import('electron');
  const directory = await mkdtemp(join(tmpdir(), 'wiki-export-'));
  let window: InstanceType<typeof BrowserWindow> | null = null;
  try {
    const html = await markdownToHtmlFile(content, title, directory);
    const target = pathToFileURL(html).href;
    // 요청마다 새 메모리 세션을 써서 앱 세션의 쿠키·저장소와 분리합니다.
    const partition = `export-pdf-${Date.now()}-${Math.random()}`;
    const isolated = session.fromPartition(partition);
    isolated.webRequest.onBeforeRequest(
      (
        details: { url: string },
        callback: (response: { cancel: boolean }) => void,
      ): void => callback({ cancel: details.url !== target }),
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.on(
      'will-navigate',
      (event: { preventDefault: () => void }): void => event.preventDefault(),
    );
    window.webContents.setWindowOpenHandler((): { action: 'deny' } => ({
      action: 'deny',
    }));
    await window.loadURL(target);
    const data = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    if (data.byteLength === 0) throw new ConversionFailed();
    return new Uint8Array(data);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}
