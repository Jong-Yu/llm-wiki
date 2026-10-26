import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import { rolldown } from 'rolldown';

const root = resolve(import.meta.dirname, '../..');
const output = await mkdtemp(join(tmpdir(), 'wiki-recovery-tests-'));
after(async () => {
  await rm(output, { recursive: true, force: true });
});
const bundle = await rolldown({
  input: 'recovery-test-entry',
  platform: 'node',
  resolve: {
    alias: {
      '@contracts': join(root, 'src/shared/contracts'),
      '@renderer': join(root, 'src/renderer'),
    },
  },
  plugins: [
    {
      name: 'recovery-test-entry',
      resolveId(id) {
        if (id === 'recovery-test-entry' || id === 'electron') return `\0${id}`;
      },
      load(id) {
        if (id === '\0electron') return 'export const dialog = {};';
        if (id === '\0recovery-test-entry')
          return [
            [
              'ProtectedRecoveryStore',
              'src/main/backend/ProtectedRecoveryStore.ts',
            ],
            ['RecoveryService', 'src/main/backend/RecoveryService.ts'],
            ['ResultDraftService', 'src/main/backend/ResultDraftService.ts'],
            ['createRecoverySlot', 'src/renderer/platform/recovery.ts'],
          ]
            .map(
              ([name, path]) =>
                `export { ${name} } from ${JSON.stringify(join(root, path))};`,
            )
            .join('\n');
      },
    },
  ],
});
await bundle.write({ file: join(output, 'service.mjs'), format: 'esm' });
await bundle.close();
const {
  ProtectedRecoveryStore,
  RecoveryService,
  ResultDraftService,
  createRecoverySlot,
} = await import(pathToFileURL(join(output, 'service.mjs')).href);
const scope = {
  serverUrl: 'https://fixture.test/api/v1/',
  userId: 'alice',
  tenant: 'alpha',
  profileId: 'all',
  policyRevision: 'e'.repeat(64),
  domain: null,
  viewpoint: null,
};
const current = () => true;
const payload = JSON.stringify({
  content: '미저장 본문\n공백 그대로 ',
  expectedRevision: 'f'.repeat(64),
  requestId: 'a'.repeat(32),
});
function cipherFixture() {
  const key = randomBytes(32);
  const control = {
    available: true,
    fail: false,
    decryptions: 0,
    gate: Promise.resolve(),
  };
  return {
    control,
    cipher: {
      async availability() {
        return {
          availability: control.available ? 'protected' : 'session_only',
          backend: control.available ? 'macos_keychain' : 'unsafe_fallback',
        };
      },
      async encrypt(text) {
        if (control.gate) await control.gate;
        if (control.fail) throw new Error('secret error');
        const iv = randomBytes(12);
        const enc = createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([enc.update(text, 'utf8'), enc.final()]);
        return Buffer.concat([iv, enc.getAuthTag(), data]);
      },
      async decrypt(bytes) {
        control.decryptions++;
        const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        dec.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([
          dec.update(bytes.subarray(28)),
          dec.final(),
        ]).toString('utf8');
      },
    },
  };
}
async function fixture() {
  const directory = await mkdtemp(join(output, 'case-'));
  const { cipher, control } = cipherFixture();
  return {
    directory,
    cipher,
    control,
    store: new ProtectedRecoveryStore(directory, cipher),
  };
}
async function saved(f, basis = scope, key = 'workspace') {
  const result = await f.store.put(
    basis,
    'result-drafts',
    key,
    payload,
    null,
    current,
  );
  assert.equal(result.ok, true);
  return result.data.entries[0];
}
async function filePath(f) {
  const [identity] = await readdir(f.directory);
  const file = (await readdir(join(f.directory, identity))).find((name) =>
    name.endsWith('.bin'),
  );
  return join(f.directory, identity, file);
}
function context() {
  return {
    active: {
      status: 'connected',
      connectionId: 'c1',
      serverUrl: scope.serverUrl,
      userId: scope.userId,
      policyRevision: scope.policyRevision,
      workspaces: [
        {
          id: 'alpha',
          permissions: ['read', 'result_write', 'write'],
          profiles: [{ id: 'all', domain: null, viewpoint: null }],
        },
      ],
    },
    selection: { tenant: 'alpha', profile: 'all' },
    generation: 1,
    token: 'never-persist-fixture-token',
  };
}
function connectionFixture() {
  const ctx = context();
  const state = { current: true, denied: false, reads: 0 };
  return {
    ctx,
    state,
    connection: {
      async analysisContext() {
        state.reads++;
        return state.denied
          ? { ok: false, error: { code: 'forbidden', message: 'denied' } }
          : ctx;
      },
      isAnalysisCurrent() {
        return state.current;
      },
      onScopeChanged() {},
      invalidateApiScope() {},
    },
  };
}
function request(operation = 'list') {
  return {
    operation,
    connectionId: 'c1',
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
    },
    kind: 'result-drafts',
  };
}

void test('encrypted restart preserves full text, original CAS and request ID without plaintext', async () => {
  const f = await fixture();
  const first = await saved(f);
  const path = await filePath(f);
  const bytes = await readFile(path);
  assert.equal(bytes.includes('미저장'), false);
  assert.equal(bytes.includes('expectedRevision'), false);
  const next = await new ProtectedRecoveryStore(f.directory, f.cipher).list(
    scope,
    'result-drafts',
    current,
  );
  assert.equal(next.ok, true);
  assert.deepEqual(next.data.entries, [first]);
});
void test('server, user, tenant, profile, policy and profile semantics are separate namespaces', async () => {
  const f = await fixture();
  await saved(f);
  for (const changed of [
    { serverUrl: 'https://other.test/api/v1/' },
    { userId: 'bob' },
    { tenant: 'beta' },
    { profileId: 'limited' },
    { policyRevision: 'd'.repeat(64) },
    { domain: 'other' },
    { viewpoint: 'other' },
  ]) {
    const result = await f.store.list(
      { ...scope, ...changed },
      'result-drafts',
      current,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.entries, []);
  }
});
void test('two instances cannot overwrite the revision read by the other app', async () => {
  const f = await fixture();
  const first = await saved(f);
  const second = new ProtectedRecoveryStore(f.directory, f.cipher);
  const fresh = await f.store.put(
    scope,
    'result-drafts',
    'workspace',
    '{"content":"latest"}',
    first.revision,
    current,
  );
  assert.equal(fresh.ok, true);
  const stale = await second.put(
    scope,
    'result-drafts',
    'workspace',
    payload,
    first.revision,
    current,
  );
  assert.equal(stale.error.code, 'recovery_conflict');
  assert.equal(
    (await second.list(scope, 'result-drafts', current)).data.entries[0]
      .payload,
    '{"content":"latest"}',
  );
});
void test('corrupt ciphertext is preserved and cannot be overwritten as a new draft', async () => {
  const f = await fixture();
  await saved(f);
  const path = await filePath(f);
  const corrupt = Buffer.from('damaged');
  await writeFile(path, corrupt);
  assert.equal(
    (await f.store.list(scope, 'result-drafts', current)).error.code,
    'recovery_corrupt',
  );
  assert.equal(
    (
      await f.store.put(
        scope,
        'result-drafts',
        'workspace',
        payload,
        null,
        current,
      )
    ).error.code,
    'recovery_corrupt',
  );
  assert.deepEqual(await readFile(path), corrupt);
});
void test('no OS protection means no plaintext or fallback file', async () => {
  const f = await fixture();
  f.control.available = false;
  assert.equal(
    (
      await f.store.put(
        scope,
        'result-drafts',
        'workspace',
        payload,
        null,
        current,
      )
    ).error.code,
    'recovery_unavailable',
  );
  assert.deepEqual(await readdir(f.directory), []);
});
void test('encryption failure preserves committed file and reports no successful save', async () => {
  const f = await fixture();
  const old = await saved(f);
  const path = await filePath(f);
  const bytes = await readFile(path);
  f.control.fail = true;
  assert.equal(
    (
      await f.store.put(
        scope,
        'result-drafts',
        'workspace',
        '{}',
        old.revision,
        current,
      )
    ).ok,
    false,
  );
  assert.deepEqual(await readFile(path), bytes);
});
void test('abandoned lock blocks mutation but permits last committed file reads', async () => {
  const f = await fixture();
  const old = await saved(f);
  const path = await filePath(f);
  const lock = join(resolve(path, '..'), 'records.lock');
  await writeFile(lock, '', { mode: 0o600 });
  assert.equal(
    (
      await f.store.put(
        scope,
        'result-drafts',
        'workspace',
        '{}',
        old.revision,
        current,
      )
    ).error.code,
    'recovery_busy',
  );
  assert.equal(
    (await f.store.list(scope, 'result-drafts', current)).data.entries[0]
      .payload,
    payload,
  );
  assert.deepEqual(await readFile(lock), Buffer.alloc(0));
});
void test('scope switch while encrypting leaves original file and cleans own temporary file', async () => {
  const f = await fixture();
  const old = await saved(f);
  const path = await filePath(f);
  const bytes = await readFile(path);
  let release;
  let valid = true;
  f.control.gate = new Promise((resolve) => {
    release = resolve;
  });
  const operation = f.store.put(
    scope,
    'result-drafts',
    'workspace',
    '{}',
    old.revision,
    () => valid,
  );
  valid = false;
  release();
  assert.equal((await operation).error.code, 'scope_changed');
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(
    (await readdir(resolve(path, '..'))).filter((name) =>
      name.endsWith('.tmp'),
    ),
    [],
  );
});
void test('recovery root symlink is rejected without writing through it', async () => {
  const f = await fixture();
  const target = join(f.directory, 'target');
  await mkdir(target, { mode: 0o700 });
  const link = join(f.directory, 'link');
  await symlink(target, link);
  const store = new ProtectedRecoveryStore(link, f.cipher);
  assert.equal(
    (
      await store.put(
        scope,
        'result-drafts',
        'workspace',
        payload,
        null,
        current,
      )
    ).error.code,
    'recovery_unsafe_path',
  );
  assert.deepEqual(await readdir(target), []);
});
void test('explicit deletion uses CAS and logout removes own server/user copies across scopes only', async () => {
  const f = await fixture();
  const old = await saved(f);
  await saved(f, { ...scope, tenant: 'beta' });
  await saved(f, { ...scope, userId: 'bob' });
  assert.equal(
    (
      await f.store.put(
        scope,
        'result-drafts',
        'workspace',
        null,
        '0'.repeat(64),
        current,
      )
    ).error.code,
    'recovery_conflict',
  );
  assert.equal(
    (
      await f.store.put(
        scope,
        'result-drafts',
        'workspace',
        null,
        old.revision,
        current,
      )
    ).ok,
    true,
  );
  assert.equal((await f.store.forgetIdentity(scope, current)).ok, true);
  assert.deepEqual(
    (await f.store.list({ ...scope, tenant: 'beta' }, 'result-drafts', current))
      .data.entries,
    [],
  );
  assert.equal(
    (await f.store.list({ ...scope, userId: 'bob' }, 'result-drafts', current))
      .data.entries.length,
    1,
  );
});
void test('authentication denial prevents decrypt and unauthorized expected scope returns no content', async () => {
  const f = await fixture();
  await saved(f);
  const c = connectionFixture();
  const service = new RecoveryService(c.connection, f.store);
  c.state.denied = true;
  assert.equal((await service.execute(request())).error.code, 'forbidden');
  assert.equal(f.control.decryptions, 0);
  c.state.denied = false;
  assert.equal(
    (
      await service.execute({
        ...request(),
        expectedScope: { ...request().expectedScope, tenant: 'beta' },
      })
    ).error.code,
    'scope_changed',
  );
  assert.equal(f.control.decryptions, 0);
  assert.equal((await service.execute(request())).data.entries.length, 1);
  assert.equal(c.state.reads, 3);
});
void test('late auth/scope change after decrypt suppresses plaintext disclosure', async () => {
  const f = await fixture();
  await saved(f);
  const c = connectionFixture();
  const original = f.cipher.decrypt.bind(f.cipher);
  f.cipher.decrypt = async (bytes) => {
    const value = await original(bytes);
    c.state.current = false;
    return value;
  };
  assert.equal(
    (await new RecoveryService(c.connection, f.store).execute(request())).error
      .code,
    'scope_changed',
  );
});
void test('logout fences subsequent and already queued writes for same connection', async () => {
  const f = await fixture();
  await saved(f);
  const c = connectionFixture();
  const service = new RecoveryService(c.connection, f.store);
  const logout = service.forgetCurrent('c1');
  const late = service.capture(c.ctx, 'question-runs', 'late', '{}', null);
  await logout;
  assert.equal((await late).ok, false);
  assert.equal(
    (await service.capture(c.ctx, 'question-runs', 'later', '{}', null)).error
      .code,
    'scope_changed',
  );
  assert.deepEqual(
    (await f.store.list(scope, 'question-runs', current)).data.entries,
    [],
  );
});
void test('main rejects serializing token-bearing context as recovery payload', async () => {
  const f = await fixture();
  const c = connectionFixture();
  const service = new RecoveryService(c.connection, f.store);
  assert.equal(
    (
      await service.capture(
        c.ctx,
        'question-runs',
        'unsafe',
        JSON.stringify(c.ctx),
        null,
      )
    ).error.code,
    'recovery_secret_field',
  );
  assert.deepEqual(await readdir(f.directory), []);
});
void test('draft POST is write-ahead journaled, response loss never reposts, receipt GET clears only known outcome', async () => {
  const f = await fixture();
  const c = connectionFixture();
  const recovery = new RecoveryService(c.connection, f.store);
  const service = new ResultDraftService(c.connection, recovery);
  const fetchOriginal = globalThis.fetch;
  const id = 'a'.repeat(32);
  const rid = 'b'.repeat(32);
  const methods = [];
  try {
    globalThis.fetch = async (_url, options) => {
      methods.push(options.method);
      const entries = await recovery.readContext(c.ctx, 'pending-result-draft');
      assert.equal(entries.data.entries[0].key, rid);
      const data = JSON.parse(entries.data.entries[0].payload);
      assert.equal(data.input.expected_revision, 'f'.repeat(64));
      assert.match(data.requestHash, /^[a-f0-9]{64}$/);
      assert.equal(
        entries.data.entries[0].payload.includes(c.ctx.token),
        false,
      );
      throw new Error('response lost');
    };
    const input = {
      draft_id: id,
      request_id: rid,
      expected_revision: 'f'.repeat(64),
      title: '초안',
      content: 'old basis',
    };
    assert.equal(
      (
        await service.execute({
          ...request(),
          kind: undefined,
          operation: 'edit',
          input,
        })
      ).error.code,
      'invalid_request',
    );
    const base = { connectionId: 'c1', expectedScope: request().expectedScope };
    assert.equal(
      (await service.execute({ ...base, operation: 'edit', input })).error.code,
      'outcome_unknown',
    );
    assert.equal(
      (await recovery.readContext(c.ctx, 'pending-result-draft')).data.entries
        .length,
      1,
    );
    globalThis.fetch = async (_url, options) => {
      methods.push(options.method);
      return new Response(
        JSON.stringify({
          data: {
            record: {
              id,
              user_id: 'alice',
              tenant: 'alpha',
              requests: { [rid]: 'f'.repeat(64) },
            },
            access: {
              user_id: 'alice',
              tenant: 'alpha',
              profile_id: 'all',
              policy_revision: 'e'.repeat(64),
              domain: null,
              viewpoint: null,
            },
          },
          meta: { trace_id: 'a'.repeat(32) },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    assert.equal(
      (
        await service.execute({
          ...base,
          operation: 'receipt',
          input: { request_id: rid, record_id: id },
        })
      ).ok,
      true,
    );
    assert.deepEqual(methods, ['PUT', 'GET']);
    assert.deepEqual(
      (await recovery.readContext(c.ctx, 'pending-result-draft')).data.entries,
      [],
    );
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
void test('renderer recovery serializes saves, preserves original revision and stops on conflict', async () => {
  const f = await fixture();
  const c = connectionFixture();
  const service = new RecoveryService(c.connection, f.store);
  globalThis.window = {
    wiki: { recovery: { execute: (req) => service.execute(req) } },
  };
  const session = { connectionId: 'c1', ...request().expectedScope };
  const slot = createRecoverySlot(
    session,
    'question-runs',
    'one',
    (value) => value,
  );
  assert.equal(await slot.load(), null);
  await Promise.all([slot.save({ value: 1 }), slot.save({ value: 2 })]);
  const peer = createRecoverySlot(
    session,
    'question-runs',
    'one',
    (value) => value,
  );
  assert.deepEqual(await peer.load(), { value: 2 });
  await slot.save({ value: 3 });
  await assert.rejects(peer.save({ value: 4 }), /recovery_conflict/);
  await assert.rejects(peer.save({ value: 5 }), /기준/);
  delete globalThis.window;
});

void test('atomic rename failure keeps old ciphertext and cleans only this write temporary', async () => {
  const f = await fixture();
  const old = await saved(f);
  const path = await filePath(f);
  const bytes = await readFile(path);
  const rename = fs.promises.rename;
  fs.promises.rename = async () => {
    throw new Error('simulated EIO');
  };
  syncBuiltinESMExports();
  try {
    const result = await f.store.put(
      scope,
      'result-drafts',
      'workspace',
      '{"content":"not committed"}',
      old.revision,
      current,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(
      (await readdir(resolve(path, '..'))).filter(
        (name) => name.endsWith('.tmp') || name.endsWith('.lock'),
      ),
      [],
    );
  } finally {
    fs.promises.rename = rename;
    syncBuiltinESMExports();
  }
});

void test('explicit logout can delete ciphertext even when OS encryption becomes unavailable', async () => {
  const f = await fixture();
  await saved(f);
  f.control.available = false;
  assert.equal((await f.store.forgetIdentity(scope, current)).ok, true);
  f.control.available = true;
  assert.deepEqual(
    (await f.store.list(scope, 'result-drafts', current)).data.entries,
    [],
  );
});

void test('an unresolved application GET receipt keeps its original pending journal', async () => {
  const f = await fixture();
  const c = connectionFixture();
  const recovery = new RecoveryService(c.connection, f.store);
  const service = new ResultDraftService(c.connection, recovery);
  const requestId = 'a'.repeat(32),
    draftId = 'b'.repeat(32);
  const journal = await recovery.capture(
    c.ctx,
    'pending-result-draft',
    requestId,
    JSON.stringify({ requestId, draftId, revision: 'f'.repeat(64) }),
    null,
  );
  assert.equal(journal.ok, true);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            request_id: requestId,
            record_id: draftId,
            saved: null,
            receipt: null,
            access: {
              user_id: 'alice',
              tenant: 'alpha',
              profile_id: 'all',
              policy_revision: scope.policyRevision,
              domain: null,
              viewpoint: null,
            },
          },
          meta: { trace_id: 'c'.repeat(32) },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const result = await service.execute({
      connectionId: 'c1',
      expectedScope: request().expectedScope,
      operation: 'applicationReceipt',
      input: { request_id: requestId, draft_id: draftId },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      (await recovery.readContext(c.ctx, 'pending-result-draft')).data.entries,
      journal.data.entries,
    );
  } finally {
    globalThis.fetch = original;
  }
});
