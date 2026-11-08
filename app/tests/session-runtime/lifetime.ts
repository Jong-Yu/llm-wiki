import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { installAppLifetime } from '@main/windows/appLifetime';
async function main(): Promise<void> {
  await app.whenReady();
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
    stopped = 0;
  const attach = installAppLifetime(app, {
    activeCount: () => 2,
    confirmQuit: async (count: number): Promise<boolean> => {
      assert.equal(count, 2);
      confirmations++;
      return accept;
    },
    shutdown: async (): Promise<void> => {
      stopped++;
      assert.equal(stopped, 1);
      assert.equal(confirmations, 2);
      assert.equal(window.isDestroyed(), false);
      console.log(
        'session-runtime: real Electron close/hide, cancelled quit, confirmed quit/cleanup passed',
      );
    },
  });
  attach(window);
  window.show();
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), false);
  window.show();
  assert.equal(window.isVisible(), true);
  app.quit();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stopped, 0);
  assert.equal(confirmations, 1);
  assert.equal(window.isDestroyed(), false);
  accept = true;
  app.quit();
  setTimeout(() => {
    console.error('lifetime did not exit');
    app.exit(1);
  }, 5000).unref();
}
void main().catch((error: unknown): void => {
  console.error(error);
  app.exit(1);
});
