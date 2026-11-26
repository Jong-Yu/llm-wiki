import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = join(appRoot, 'tests/ipc/entry.ts');
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
      name: 'ipc-test-entry',
      resolveId(source) {
        if (source === entry) return '\0ipc-test-entry';
        if (source === 'electron') return '\0electron';
      },
      load(id) {
        if (id === '\0electron')
          return `
        export const handlers = new Map();
          export const ipcMain = { handle: (name, handler) => {
            if (handlers.has(name)) throw new Error('Duplicate IPC handler');
            handlers.set(name, handler);
          } };
      `;
        if (id === '\0ipc-test-entry')
          return `
        export { handlers } from 'electron';
        export { createIpcRegistrar } from '@main/ipc/registerIpcHandlers';
        export { registerNotificationHandlers } from '@main/ipc/registerNotificationHandlers';
        export { registerRegistrationDraftHandlers } from '@main/ipc/registerRegistrationDraftHandlers';
        export { NOTIFICATION_CHANNELS } from '@contracts/notifications.contract';
        export { REGISTRATION_DRAFT_CHANNELS } from '@contracts/registrationDrafts.contract';
      `;
      },
    },
  ],
  ssr: { noExternal: true },
  build: { ssr: entry, write: false },
});
const chunk = bundle.output.find((value) => value.type === 'chunk');
assert(chunk);
const temporary = await mkdtemp(join(tmpdir(), 'wiki-ipc-'));
let product;
try {
  const file = join(temporary, 'verify.mjs');
  await writeFile(file, chunk.code);
  product = await import(pathToFileURL(file).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const renderer = 'file:///isolated-ipc-test/renderer/index.html';
const frame = { url: renderer + '#/tasks' };
const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
let activeWindow = window;
const event = { sender: window.webContents, senderFrame: frame };
const scope = {
  userId: 'tester',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: 'a'.repeat(64),
};
const session = { connectionId: 'fixture', expectedScope: scope };
const get = {
  ...session,
  workflowId: 'b'.repeat(32),
  sourceRef: {
    source_id: 'c'.repeat(32),
    source_version: 'd'.repeat(32),
    source_sha256: 'e'.repeat(64),
    registration_revision: 'f'.repeat(64),
  },
  conversionRef: null,
};
const notificationFailure = {
  ok: false,
  error: { code: 'synthetic_rejection', message: '업무 거절 보존' },
};
const draftSuccess = {
  ok: true,
  data: {
    draft: null,
    revision: null,
    savedAt: null,
    cleared: null,
    cleanupWarningCount: 0,
  },
};
let calls = [];
const notifications = Object.fromEntries(
  Object.keys(product.NOTIFICATION_CHANNELS).map((key) => [
    key,
    async (request) => {
      calls.push({ key, request });
      return notificationFailure;
    },
  ]),
);
const drafts = Object.fromEntries(
  Object.keys(product.REGISTRATION_DRAFT_CHANNELS).map((key) => [
    key,
    async (request) => {
      calls.push({ key, request });
      return draftSuccess;
    },
  ]),
);
product.registerNotificationHandlers(
  () => activeWindow,
  renderer,
  notifications,
);
product.registerRegistrationDraftHandlers(() => activeWindow, renderer, drafts);
const list = product.handlers.get(product.NOTIFICATION_CHANNELS.list);
const readDraft = product.handlers.get(product.REGISTRATION_DRAFT_CHANNELS.get);

await test('registered operations preserve allowed requests and validated results', async () => {
  assert.equal(product.handlers.size, 16);
  assert.deepEqual(await list(event, session), notificationFailure);
  assert.deepEqual(calls.at(-1), { key: 'list', request: session });
  assert.deepEqual(await readDraft(event, get), draftSuccess);
  assert.deepEqual(calls.at(-1), { key: 'get', request: get });
});

await test('untrusted sender, iframe, other document and unavailable window never invoke operations', async () => {
  const count = calls.length;
  for (const bad of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: frame.url } },
    { ...event, senderFrame: { url: 'https://external.invalid/' } },
  ]) {
    assert.equal((await list(bad, session)).error.code, 'forbidden');
  }
  frame.url = renderer + '?different-document';
  assert.equal((await readDraft(event, get)).error.code, 'forbidden');
  frame.url = renderer + '#/tasks';
  activeWindow = null;
  assert.equal((await list(event, session)).error.code, 'forbidden');
  activeWindow = { ...window, isDestroyed: () => true };
  assert.equal((await readDraft(event, get)).error.code, 'forbidden');
  activeWindow = window;
  assert.equal(calls.length, count);
});

await test('argument count is checked before parsers and retains each message', async () => {
  const count = calls.length;
  assert.deepEqual(await list(event), {
    ok: false,
    error: { code: 'invalid_request', message: '알림 요청을 확인해 주세요.' },
  });
  assert.deepEqual(await readDraft(event, get, get), {
    ok: false,
    error: {
      code: 'invalid_request',
      message: '등록 초안 요청 항목을 확인해 주세요.',
    },
  });
  assert.equal(calls.length, count);
});

await test('malformed requests retain the existing domain-specific exception mapping', async () => {
  const count = calls.length;
  assert.equal(
    (await list(event, { ...session, extra: true })).error.code,
    'notification_unavailable',
  );
  assert.equal(
    (await readDraft(event, { ...get, workflowId: 'bad' })).error.code,
    'registration_draft_unavailable',
  );
  assert.equal(calls.length, count);
});

await test('malformed responses and synchronous/asynchronous failures stay private', async () => {
  for (const operation of [
    () => ({ ok: true, data: { invalid: true } }),
    () => {
      throw new Error('private synchronous detail');
    },
    async () => {
      throw new Error('private asynchronous detail');
    },
  ]) {
    const failingNotifications = { ...notifications, list: operation };
    const failingDrafts = { ...drafts, get: operation };
    product.handlers.clear();
    product.registerNotificationHandlers(
      () => window,
      renderer,
      failingNotifications,
    );
    product.registerRegistrationDraftHandlers(
      () => window,
      renderer,
      failingDrafts,
    );
    const notification = await product.handlers.get(
      product.NOTIFICATION_CHANNELS.list,
    )(event, session);
    const draft = await product.handlers.get(
      product.REGISTRATION_DRAFT_CHANNELS.get,
    )(event, get);
    assert.deepEqual(notification, {
      ok: false,
      error: {
        code: 'notification_unavailable',
        message:
          '알림 상태를 확인하지 못했습니다. 저장 여부를 다시 조회해 주세요.',
      },
    });
    assert.deepEqual(draft, {
      ok: false,
      error: {
        code: 'registration_draft_unavailable',
        message:
          '등록 초안을 보관하거나 복원하지 못했습니다. 현재 입력과 기존 초안은 보존됩니다.',
      },
    });
  }
});

await test('image recovery validates scope, fixed revision and candidate result before crossing IPC', async () => {
  const request = {
    ...session,
    workflowId: 'b'.repeat(32),
    requestId: 'c'.repeat(32),
    expectedRevision: 'd'.repeat(64),
  };
  let result = {
    ok: true,
    data: {
      units: [
        {
          unit_id: 'slide-2',
          content: '복구 후보',
          warnings: ['원래 저신뢰 진단'],
        },
      ],
      warnings: [],
      provider: 'claude',
      model: null,
    },
  };
  let count = 0;
  product.handlers.clear();
  product.registerNotificationHandlers(() => window, renderer, {
    ...notifications,
    recoverImages: async () => {
      count += 1;
      return result;
    },
  });
  const recover = product.handlers.get(
    product.NOTIFICATION_CHANNELS.recoverImages,
  );
  assert.deepEqual(await recover(event, request), result);
  assert.equal(count, 1);
  assert.equal(
    (await recover({ ...event, sender: {} }, request)).error.code,
    'forbidden',
  );
  assert.equal(
    (await recover(event, { ...request, expectedRevision: 'bad' })).ok,
    false,
  );
  assert.equal(count, 1);
  result = {
    ok: true,
    data: {
      ...result.data,
      units: [{ unit_id: 'slide-2', content: '', warnings: [] }],
    },
  };
  assert.equal(
    (await recover(event, request)).error.code,
    'notification_unavailable',
  );
});

await test('zero-argument connection-style operations keep count and failure semantics', async () => {
  const registrar = product.createIpcRegistrar(() => window, renderer, {
    invalidRequest: '앱 요청의 입력을 확인해 주세요.',
    unexpected: {
      code: 'invalid_request',
      message: '앱 요청의 입력을 확인해 주세요.',
    },
  });
  let count = 0;
  registrar.register('synthetic:state', 0, () => {
    count += 1;
    return { ok: true, data: 'state' };
  });
  const state = product.handlers.get('synthetic:state');
  assert.deepEqual(await state(event), { ok: true, data: 'state' });
  assert.equal((await state(event, undefined)).error.code, 'invalid_request');
  assert.equal(count, 1);
  registrar.register('synthetic:fail', 0, () => {
    throw new Error('private');
  });
  assert.deepEqual(await product.handlers.get('synthetic:fail')(event), {
    ok: false,
    error: {
      code: 'invalid_request',
      message: '앱 요청의 입력을 확인해 주세요.',
    },
  });
});
