import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = join(appRoot, 'tests/voc/entry.ts');
const bundle = await build({
  configFile: false,
  root: appRoot,
  logLevel: 'error',
  resolve: {
    alias: {
      '@main': join(appRoot, 'src/main'),
      '@contracts': join(appRoot, 'src/shared/contracts'),
      electron: '\0electron',
    },
  },
  plugins: [
    {
      name: 'voc-test-entry',
      resolveId(source) {
        if (source === entry) return '\0voc-test-entry';
        if (source === 'electron') return '\0electron';
      },
      load(id) {
        if (id === '\0electron')
          return `
        export const handlers = new Map();
        export const ipcMain = {handle: (name, handler) => handlers.set(name, handler)};
      `;
        if (id === '\0voc-test-entry')
          return `
        export {handlers} from 'electron';
        export {ConnectionService} from '@main/backend/ConnectionService';
        export {registerVocHandlers} from '@main/ipc/registerVocHandlers';
        export {VOC_CHANNELS, vocSubmitSchema} from '@contracts/voc.contract';
        export {createWikiBridge} from '${join(appRoot, 'src/shared/createWikiBridge.ts')}';
      `;
      },
    },
  ],
  ssr: { noExternal: true },
  build: { ssr: entry, write: false },
});
const chunk = bundle.output.find((value) => value.type === 'chunk');
assert(chunk);
const temporary = await mkdtemp(join(tmpdir(), 'wiki-voc-'));
let product;
try {
  const file = join(temporary, 'verify.mjs');
  await writeFile(file, chunk.code);
  product = await import(pathToFileURL(file).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const receipt = {
  report_id: 'b'.repeat(32),
  created_at: '2026-11-26T10:00:00+00:00',
};
const access = {
  data: {
    user_id: 'unassigned-user',
    policy_revision: 'a'.repeat(64),
    memberships: {},
    default_tenant: null,
  },
  meta: { trace_id: 'c'.repeat(32) },
};
const originalFetch = globalThis.fetch;
let calls = [];
let respond;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (String(url).endsWith('/access-context')) return Response.json(access);
  return respond(url, init);
};

async function connected() {
  const service = new product.ConnectionService();
  const result = await service.connect({
    serverUrl: 'http://127.0.0.1:49999/prefix/',
    token: 'isolated-voc-token',
  });
  assert(result.ok && result.data.status === 'connected');
  assert.equal(result.data.selection, null);
  return { service, connectionId: result.data.connectionId };
}

try {
  await test('unassigned authenticated user submits exact text using a private token and no scope', async () => {
    const { service, connectionId } = await connected();
    calls = [];
    respond = async () =>
      Response.json(
        { data: receipt, meta: { trace_id: 'd'.repeat(32) } },
        { status: 201 },
      );
    const content = '  오류 내용\n한글과 "인용" 보존  ';
    assert.deepEqual(await service.submitVoc({ connectionId, content }), {
      ok: true,
      data: receipt,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'http://127.0.0.1:49999/prefix/api/v1/voc');
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(
      calls[1].init.headers.Authorization,
      'Bearer isolated-voc-token',
    );
    assert.equal(calls[1].init.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[1].init.body), { content });
    assert(
      !JSON.stringify(await service.getState()).includes('isolated-voc-token'),
    );
  });

  await test('blank, oversized, stale connection and changed identity do not submit', async () => {
    const { service, connectionId } = await connected();
    calls = [];
    assert.equal(
      (await service.submitVoc({ connectionId, content: ' \n ' })).error.code,
      'invalid_request',
    );
    assert.equal(
      (await service.submitVoc({ connectionId: 'old', content: 'report' }))
        .error.code,
      'connection_changed',
    );
    assert.equal(
      product.vocSubmitSchema.safeParse({
        connectionId,
        content: '한'.repeat(3 * 1024 * 1024),
      }).success,
      false,
    );
    assert.equal(calls.length, 0);
    access.data.user_id = 'other-user';
    assert.equal(
      (await service.submitVoc({ connectionId, content: 'report' })).error.code,
      'subject_changed',
    );
    access.data.user_id = 'unassigned-user';
    assert.equal(calls.length, 1);
  });

  await test('HTTP failure, malformed receipt and response loss never retry or leak server text', async () => {
    const { service, connectionId } = await connected();
    for (const response of [
      async () =>
        Response.json(
          { error: { code: 'unauthorized', message: 'private detail' } },
          { status: 401 },
        ),
      async () =>
        Response.json(
          { data: { report_id: '../invalid', created_at: 'wrong' } },
          { status: 201 },
        ),
      async () => {
        throw new Error('private network detail');
      },
    ]) {
      calls = [];
      respond = response;
      const result = await service.submitVoc({
        connectionId,
        content: 'preserved report',
      });
      assert.equal(result.ok, false);
      assert(!JSON.stringify(result).includes('private'));
      assert.equal(
        calls.filter(({ init }) => init.method === 'POST').length,
        1,
      );
    }
  });

  await test('logout during submit cannot publish an old success to a new session', async () => {
    const { service, connectionId } = await connected();
    let finish;
    let started;
    const submitted = new Promise((resolve) => {
      started = resolve;
    });
    respond = () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      });
    const pending = service.submitVoc({ connectionId, content: 'report' });
    await submitted;
    service.disconnect();
    finish(Response.json({ data: receipt }, { status: 201 }));
    assert.equal((await pending).error.code, 'connection_changed');
  });

  await test('bridge and IPC validate the sender, request and response before exposing a receipt', async () => {
    const renderer = 'file:///isolated-voc/renderer/index.html';
    const frame = { url: renderer + '#/report-error' };
    const window = {
      isDestroyed: () => false,
      webContents: { mainFrame: frame },
    };
    const event = { sender: window.webContents, senderFrame: frame };
    let submits = 0;
    let result = { ok: true, data: receipt };
    product.registerVocHandlers(() => window, renderer, {
      submitVoc: async () => {
        submits++;
        return result;
      },
    });
    const handler = product.handlers.get(product.VOC_CHANNELS.submit);
    const request = { connectionId: 'fixture', content: 'report' };
    assert.equal(
      (await handler({ ...event, sender: {} }, request)).error.code,
      'forbidden',
    );
    assert.equal((await handler(event)).error.code, 'invalid_request');
    assert.equal(
      (await handler(event, { ...request, token: 'injected' })).error.code,
      'voc_unavailable',
    );
    assert.equal(submits, 0);
    const bridge = product.createWikiBridge(async (channel, value) => {
      assert.equal(channel, product.VOC_CHANNELS.submit);
      return handler(event, value);
    });
    assert.deepEqual(await bridge.voc.submit(request), result);
    result = { ok: true, data: { invalid: true } };
    assert.equal(
      (await bridge.voc.submit(request)).error.code,
      'voc_unavailable',
    );
    await assert.rejects(bridge.voc.submit({ ...request, content: '\n' }));
  });
} finally {
  globalThis.fetch = originalFetch;
}
