import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, Tray } from 'electron';
import type { Menu } from 'electron';
import { installAppLifetime, showAppWindow } from '@main/windows/appLifetime';
import { createAppTray } from '@main/windows/createAppTray';

/** 실제 창·트레이와 기존 종료 절차를 격리된 Electron 프로세스에서 검사합니다. */
async function main(): Promise<void> {
  const testRoot = process.env.WIKI_RUNTIME_TEST_ROOT;
  assert.ok(testRoot);
  app.setPath('userData', join(testRoot, 'electron-user-data'));
  await app.whenReady();
  const timeout = setTimeout((): void => {
    console.error('lifetime did not exit');
    app.exit(1);
  }, 15000);
  timeout.unref();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let accept = false,
    confirmations = 0,
    stopped = 0,
    failShutdown = false;
  const attach = installAppLifetime(app, {
    activeCount: () => 2,
    confirmQuit: async (count: number): Promise<boolean> => {
      assert.equal(count, 2);
      confirmations++;
      showAppWindow(window);
      return accept;
    },
    shutdown: async (): Promise<void> => {
      stopped++;
      if (failShutdown) throw new Error('simulated cleanup failure');
      assert.equal(stopped, 2);
      assert.equal(confirmations, 3);
      assert.equal(window.isDestroyed(), false);
    },
  });
  attach(window);

  // 실제 트레이에 전달한 네이티브 메뉴를 관찰하고 같은 click 핸들러를 호출합니다.
  const captured: { menu: Menu | null } = { menu: null };
  const setContextMenu = Tray.prototype.setContextMenu;
  const captureMenu = mock.method(
    Tray.prototype,
    'setContextMenu',
    function (this: Tray, menu: Menu | null): void {
      captured.menu = menu;
      setContextMenu.call(this, menu);
    },
  );
  const tray = createAppTray(app, {
    iconPath: join(
      process.cwd(),
      'design/brand',
      process.platform === 'win32' ? 'llm-wiki-icon.ico' : 'llm-wiki-icon.png',
    ),
    showWindow: (): void => showAppWindow(window),
  });
  captureMenu.mock.restore();
  assert.equal(tray.isDestroyed(), false);
  assert.ok(captured.menu);
  const [openItem, separator, quitItem] = captured.menu.items;
  assert.equal(openItem.label, '앱 열기');
  assert.equal(separator.type, 'separator');
  assert.equal(quitItem.label, '종료');

  window.show();
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), false);
  assert.equal(stopped, 0);
  openItem.click();
  assert.equal(window.isVisible(), true);
  window.close();
  tray.emit('click');
  assert.equal(window.isVisible(), true);
  window.close();
  tray.emit('double-click');
  assert.equal(window.isVisible(), true);
  assert.equal(BrowserWindow.getAllWindows().length, 1);

  const minimized = once(window, 'minimize');
  window.minimize();
  await minimized;
  assert.equal(window.isMinimized(), true);
  const restored = once(window, 'restore');
  openItem.click();
  await restored;
  assert.equal(window.isMinimized(), false);
  assert.equal(window.isVisible(), true);

  window.close();
  quitItem.click();
  await delay(100);
  assert.equal(stopped, 0);
  assert.equal(confirmations, 1);
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), true);
  assert.equal(tray.isDestroyed(), false);

  accept = true;
  failShutdown = true;
  quitItem.click();
  await delay(100);
  assert.equal(stopped, 1);
  assert.equal(window.isDestroyed(), false);
  assert.equal(tray.isDestroyed(), false);
  window.close();
  openItem.click();
  assert.equal(window.isVisible(), true);

  failShutdown = false;
  app.once('will-quit', (): void => {
    assert.equal(tray.isDestroyed(), true);
    console.log(
      'session-runtime: native tray menu/click, close/hide, minimize/restore, cancelled quit, cleanup failure/retry, confirmed quit passed',
    );
  });
  quitItem.click();
}
void main().catch((error: unknown): void => {
  console.error(error);
  app.exit(1);
});
