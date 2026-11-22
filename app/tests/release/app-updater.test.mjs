// 실행: node --experimental-vm-modules --test tests/release/app-updater.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const file = new URL('../../src/main/updates/AppUpdater.ts', import.meta.url);
const source = ts.transpileModule(await readFile(file, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
  },
}).outputText;

/** 외부 통신과 설치를 대체하고 실제 배포 판별·업데이트 상태 전이를 실행합니다. */
async function fixture({ packaged = true, metadata = '{}', readError } = {}) {
  const trace = {
    reads: [],
    updaterAccesses: 0,
    checks: 0,
    installs: [],
    timers: [],
    errors: [],
  };
  const handlers = new Map();
  const autoUpdater = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    async checkForUpdates() {
      trace.checks += 1;
    },
    quitAndInstall(...args) {
      trace.installs.push(args);
    },
  };
  const context = vm.createContext({
    console: { error: (...args) => trace.errors.push(args) },
    setInterval(callback, interval) {
      trace.timers.push({ callback, interval });
      return { unref() {} };
    },
  });
  const imports = {
    electron: {
      app: {
        isPackaged: packaged,
        getAppPath: () => '/fixture/LLM Wiki/resources/app.asar',
      },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
    },
    'node:fs': {
      readFileSync(path, encoding) {
        trace.reads.push({ path, encoding });
        if (readError) throw readError;
        return metadata;
      },
    },
    'node:path': { join: (...parts) => parts.join('/') },
    'electron-updater': {
      default: {
        get autoUpdater() {
          trace.updaterAccesses += 1;
          return autoUpdater;
        },
      },
    },
  };
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: fileURLToPath(file),
  });
  await module.link(async (name) => {
    assert.ok(name in imports, `unexpected runtime import: ${name}`);
    const exports = imports[name];
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports))
          this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  return {
    updater: module.namespace.createAppUpdater(() => null),
    trace,
    handlers,
    autoUpdater,
  };
}

test('portable never checks, downloads, schedules, or installs an installer', async () => {
  const { updater, trace } = await fixture({
    metadata: JSON.stringify({ llmWikiDistribution: 'portable' }),
  });
  updater.start();
  assert.equal(updater.getStatus().state, 'idle');
  assert.equal(updater.install(), false);
  assert.equal(trace.reads.length, 1);
  assert.equal(trace.updaterAccesses, 0);
  assert.equal(trace.checks, 0);
  assert.equal(trace.timers.length, 0);
  assert.equal(trace.installs.length, 0);
});

test('existing installed distributions keep update and explicit installation behavior', async () => {
  const { updater, trace, handlers, autoUpdater } = await fixture();
  updater.start();
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(trace.checks, 1);
  assert.equal(trace.timers.length, 1);
  assert.equal(trace.timers[0].interval, 4 * 60 * 60 * 1000);
  handlers.get('update-available')({ version: '0.1.1' });
  assert.equal(updater.getStatus().state, 'downloading');
  assert.equal(updater.install(), false);
  handlers.get('update-downloaded')({ version: '0.1.1' });
  assert.equal(updater.getStatus().state, 'ready');
  assert.equal(updater.install(), true);
  assert.deepEqual(trace.installs, [[true, true]]);
});

test('development does not read packaging metadata or initialize updater', async () => {
  const { updater, trace } = await fixture({ packaged: false });
  updater.start();
  assert.equal(trace.reads.length, 0);
  assert.equal(trace.updaterAccesses, 0);
});

test('missing or invalid packaging metadata cannot enable installer updates', async () => {
  for (const options of [
    { readError: new Error('missing package') },
    { metadata: '{invalid' },
    { metadata: 'null' },
    { metadata: '[]' },
  ]) {
    const { updater, trace } = await fixture(options);
    updater.start();
    assert.equal(updater.install(), false);
    assert.equal(trace.updaterAccesses, 0);
    assert.equal(trace.checks, 0);
    assert.equal(trace.installs.length, 0);
  }
});
