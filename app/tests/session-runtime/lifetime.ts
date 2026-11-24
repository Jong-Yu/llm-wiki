import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, Tray } from 'electron';
import type { Menu, NativeImage } from 'electron';
import { installAppLifetime, showAppWindow } from '@main/windows/appLifetime';
import { createAppTray } from '@main/windows/createAppTray';
import { watchSystemIconTheme } from '@main/windows/watchSystemIconTheme';

/** Windows의 서로 다른 앱·시스템 테마 조합을 OS 설정 변경 없이 재현합니다. */
class TestSystemTheme extends EventEmitter {
  shouldUseDarkColors = false;
  shouldUseDarkColorsForSystemIntegratedUI = true;
}

/** 실제 창·트레이와 기존 종료 절차를 격리된 Electron 프로세스에서 검사합니다. */
async function main(): Promise<void> {
  const testRoot = process.env.WIKI_RUNTIME_TEST_ROOT;
  assert.ok(testRoot);
  app.setPath('userData', join(testRoot, 'electron-user-data'));
  await app.whenReady();
  let stage = 'setup';
  const timeout = setTimeout((): void => {
    console.error(`lifetime did not exit: ${stage}`);
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
  await window.loadURL(
    'data:text/html,<title>Icon lifetime verification</title>',
  );

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
  const theme = new TestSystemTheme();
  const appliedIcons: (NativeImage | string)[] = [];
  const setImage = Tray.prototype.setImage;
  const captureImage = mock.method(
    Tray.prototype,
    'setImage',
    function (this: Tray, icon: NativeImage | string): void {
      appliedIcons.push(icon);
      setImage.call(this, icon);
    },
  );
  const iconPath = join(
    process.cwd(),
    'design/brand',
    process.platform === 'win32' ? 'llm-wiki-icon.ico' : 'llm-wiki-icon.png',
  );
  const darkIconPath = join(
    process.cwd(),
    'design/brand',
    process.platform === 'win32'
      ? 'llm-wiki-icon-dark.ico'
      : 'llm-wiki-icon-dark.png',
  );
  const tray = createAppTray(
    app,
    { iconPath, darkIconPath, showWindow: (): void => showAppWindow(window) },
    theme,
  );
  captureMenu.mock.restore();
  assert.deepEqual(appliedIcons, [darkIconPath]);
  assert.equal(theme.listenerCount('updated'), 1);
  // 앱만 어두워져도 시스템 UI가 그대로면 아이콘을 다시 바꾸지 않습니다.
  theme.shouldUseDarkColors = true;
  theme.emit('updated');
  assert.deepEqual(appliedIcons, [darkIconPath]);
  theme.shouldUseDarkColorsForSystemIntegratedUI = false;
  theme.emit('updated');
  assert.deepEqual(appliedIcons, [darkIconPath, iconPath]);
  theme.shouldUseDarkColors = false;
  theme.shouldUseDarkColorsForSystemIntegratedUI = true;
  theme.emit('updated');
  assert.deepEqual(appliedIcons, [darkIconPath, iconPath, darkIconPath]);
  const standalone: boolean[] = [];
  const stopStandalone = watchSystemIconTheme((dark: boolean): void => {
    standalone.push(dark);
  }, theme);
  assert.deepEqual(standalone, [true]);
  stopStandalone();
  stopStandalone();
  assert.equal(tray.isDestroyed(), false);
  assert.equal(theme.listenerCount('updated'), 1);
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
  stage = 'minimize';
  window.minimize();
  await minimized;
  assert.equal(window.isMinimized(), true);
  const restored = once(window, 'restore');
  stage = 'restore';
  openItem.click();
  await restored;
  assert.equal(window.isMinimized(), false);
  assert.equal(window.isVisible(), true);

  window.close();
  stage = 'cancel quit';
  quitItem.click();
  await delay(100);
  assert.equal(stopped, 0);
  assert.equal(confirmations, 1);
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), true);
  assert.equal(tray.isDestroyed(), false);
  assert.equal(theme.listenerCount('updated'), 1);
  theme.shouldUseDarkColorsForSystemIntegratedUI = false;
  theme.emit('updated');
  assert.equal(appliedIcons.at(-1), iconPath);
  assert.deepEqual(standalone, [true]);

  accept = true;
  failShutdown = true;
  stage = 'failed cleanup';
  quitItem.click();
  await delay(100);
  assert.equal(stopped, 1);
  assert.equal(window.isDestroyed(), false);
  assert.equal(tray.isDestroyed(), false);
  assert.equal(theme.listenerCount('updated'), 1);
  theme.shouldUseDarkColorsForSystemIntegratedUI = true;
  theme.emit('updated');
  assert.equal(appliedIcons.at(-1), darkIconPath);
  window.close();
  openItem.click();
  assert.equal(window.isVisible(), true);

  failShutdown = false;
  stage = 'final quit';
  app.once('will-quit', (): void => {
    stage = 'will-quit assertions';
    assert.equal(tray.isDestroyed(), true);
    assert.equal(theme.listenerCount('updated'), 0);
    const before = appliedIcons.length;
    theme.shouldUseDarkColorsForSystemIntegratedUI = false;
    theme.emit('updated');
    assert.equal(appliedIcons.length, before);
    captureImage.mock.restore();
    console.log(
      'session-runtime: system/app mixed themes, tray icon updates/disposal, native menu/click, close/hide, minimize/restore, cancelled quit, cleanup failure/retry, confirmed quit passed',
    );
  });
  quitItem.click();
}
void main().catch((error: unknown): void => {
  console.error(error);
  app.exit(1);
});
