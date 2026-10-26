import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  stat,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { rolldown } from 'rolldown';

// 공통 app/out 빌드와 무관한 전용 번들로 main 서비스의 실제 HTTP/파일 동작을 검사합니다.
const root = resolve(import.meta.dirname, '../..');
const output = await mkdtemp(join(tmpdir(), 'wiki-protection-tests-'));
after(async () => {
  await rm(output, { recursive: true, force: true });
});
const bundle = await rolldown({
  input: 'connection-protection-test-entry',
  platform: 'node',
  resolve: { alias: { '@contracts': join(root, 'src/shared/contracts') } },
  plugins: [
    {
      name: 'connection-protection-test',
      resolveId(id) {
        if (id === 'connection-protection-test-entry' || id === 'electron')
          return `\0${id}`;
      },
      load(id) {
        if (id === '\0connection-protection-test-entry')
          return `export { ConnectionService } from ${JSON.stringify(join(root, 'src/main/backend/ConnectionService.ts'))}; export { ProtectedConnectionStore } from ${JSON.stringify(join(root, 'src/main/backend/ProtectedConnectionStore.ts'))}; export { parseConnectionResult, parseConnectRequest } from ${JSON.stringify(join(root, 'src/shared/contracts/connection.contract.ts'))};`;
        if (id === '\0electron') return 'export const dialog = {};';
      },
    },
  ],
});
await bundle.write({ file: join(output, 'service.mjs'), format: 'esm' });
await bundle.close();
const {
  ConnectionService,
  ProtectedConnectionStore,
  parseConnectionResult,
  parseConnectRequest,
} = await import(pathToFileURL(join(output, 'service.mjs')).href);

function cipherFixture() {
  const key = randomBytes(32);
  const control = {
    available: true,
    encryptFails: false,
    decryptFails: false,
    encryptions: 0,
    gate: Promise.resolve(),
  };
  const cipher = {
    async availability() {
      return control.available
        ? { availability: 'protected', backend: 'macos_keychain' }
        : { availability: 'session_only', backend: 'unsafe_fallback' };
    },
    async encrypt(text) {
      control.encryptions += 1;
      if (control.gate) await control.gate;
      if (control.encryptFails) throw new Error('synthetic encryption failure');
      const nonce = randomBytes(12);
      const encoder = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([
        encoder.update(text, 'utf8'),
        encoder.final(),
      ]);
      return Buffer.concat([nonce, encoder.getAuthTag(), body]);
    },
    async decrypt(bytes) {
      if (control.decryptFails) throw new Error('synthetic decryption failure');
      const decoder = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decoder.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decoder.update(bytes.subarray(28)),
        decoder.final(),
      ]).toString('utf8');
    },
  };
  return { cipher, control };
}

async function fixture(t) {
  const directory = await mkdtemp(join(output, 'case-'));
  const { cipher, control } = cipherFixture();
  const token = randomBytes(32).toString('hex');
  const remote = {
    user: 'alice',
    policy: 'policy-v1',
    domain: 'research',
    tenant: true,
    read: true,
    status: 200,
    calls: 0,
    gate: Promise.resolve(),
  };
  const server = createServer(async (request, response) => {
    remote.calls += 1;
    if (remote.gate) await remote.gate;
    const authorized = request.headers.authorization === `Bearer ${token}`;
    response.writeHead(authorized ? remote.status : 401, {
      'Content-Type': 'application/json',
    });
    response.end(
      JSON.stringify({
        data: {
          user_id: remote.user,
          policy_revision: remote.policy,
          memberships: remote.tenant
            ? {
                alpha: {
                  permissions: remote.read ? ['read', 'source_write'] : [],
                  default_profile: 'all',
                  profiles: { all: { domain: remote.domain, viewpoint: null } },
                },
              }
            : {},
        },
        meta: { trace_id: 'a'.repeat(32) },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/proxy`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const storePath = join(directory, 'vault');
  const fresh = () =>
    new ConnectionService(new ProtectedConnectionStore(storePath, cipher));
  const service = fresh();
  const select = async (target = service) => {
    const state = target.getState();
    assert.equal(state.data.status, 'connected');
    return target.selectWorkspace({
      connectionId: state.data.connectionId,
      tenant: 'alpha',
      profile: 'all',
    });
  };
  const connect = (remember = true) =>
    service.connect({ serverUrl: base, token, remember });
  const file = join(storePath, 'selected.bin');
  return {
    directory,
    storePath,
    file,
    fresh,
    service,
    select,
    connect,
    remote,
    control,
    cipher,
    token,
    base,
  };
}

void test('encrypted opt-in selection survives fresh service and rechecks real HTTP authority', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.connect()).ok, true);
  assert.equal((await f.select()).ok, true);
  const original = f.service.getState();
  const bytes = await readFile(f.file);
  assert.equal(bytes.includes(f.token), false);
  assert.equal(bytes.includes('alice'), false);
  if (process.platform !== 'win32')
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  f.service.disconnect();
  assert.deepEqual(await readFile(f.file), bytes);
  const restarted = f.fresh();
  const calls = f.remote.calls;
  const result = await restarted.initialize();
  assert.equal(f.remote.calls, calls + 1);
  assert.deepEqual(result.data.selection, { tenant: 'alpha', profile: 'all' });
  assert.notEqual(result.data.connectionId, original.data.connectionId);
  assert.equal(result.data.protection.remembered, true);
  await restarted.initialize();
  assert.equal(f.remote.calls, calls + 1);
  assert.equal(JSON.stringify(result).includes(f.token), false);
  assert.deepEqual(await readFile(f.file), bytes);
});

void test('restart rejects revoked credential, identity, policy, tenant, read permission and profile meaning changes', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  const bytes = await readFile(f.file);
  for (const change of [
    { status: 401 },
    { status: 403 },
    { user: 'bob' },
    { policy: 'policy-v2' },
    { tenant: false },
    { read: false },
    { domain: 'different' },
  ]) {
    const before = { ...f.remote };
    Object.assign(f.remote, change);
    const restarted = f.fresh();
    const result = await restarted.initialize();
    assert.equal(result.ok, false);
    assert.equal(restarted.getState().data.status, 'disconnected');
    assert.deepEqual(await readFile(f.file), bytes);
    const count = f.remote.calls;
    await restarted.initialize();
    assert.equal(f.remote.calls, count);
    Object.assign(f.remote, before);
    assert.equal((await restarted.restoreSaved()).ok, true);
  }
});

void test('failed new connection preserves active scope and stored bytes; successful session-only switch removes old saved choice', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  const before = f.service.getState();
  const bytes = await readFile(f.file);
  assert.equal(
    (
      await f.service.connect({
        serverUrl: f.base,
        token: 'invalid',
        remember: true,
      })
    ).ok,
    false,
  );
  assert.deepEqual(f.service.getState(), before);
  assert.deepEqual(await readFile(f.file), bytes);
  assert.equal((await f.connect(false)).ok, true);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.equal(f.service.getState().data.protection.remembered, false);
});

void test('forget retains active session, stops subsequent saving; logout removes credential and prevents restart restoration', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  assert.equal((await f.service.forgetSaved()).data.status, 'connected');
  await f.select();
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  await f.connect();
  await f.select();
  assert.equal((await f.service.logout()).data.status, 'disconnected');
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.equal((await f.fresh().initialize()).data.status, 'disconnected');
});

void test('unsafe fallback never encrypts or persists plaintext and still supports session connection', async (t) => {
  const f = await fixture(t);
  f.control.available = false;
  const result = await f.connect();
  await f.select();
  assert.equal(result.ok, true);
  assert.equal(result.data.protection.availability, 'session_only');
  assert.equal(f.control.encryptions, 0);
  assert.deepEqual(await readdir(f.storePath), []);
});

void test('encryption failure preserves previous bytes; corrupt/decryption failures never overwrite and allow explicit forget', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  const bytes = await readFile(f.file);
  f.control.encryptFails = true;
  const result = await f.connect();
  assert.equal(result.ok, true);
  assert.equal(result.data.protection.issue, 'storage_write_failed');
  assert.equal(result.data.protection.remembered, false);
  assert.deepEqual(await readFile(f.file), bytes);
  f.control.encryptFails = false;
  f.control.decryptFails = true;
  assert.equal((await f.fresh().initialize()).ok, false);
  assert.deepEqual(await readFile(f.file), bytes);
  f.control.decryptFails = false;
  await writeFile(f.file, Buffer.from('corrupt fixture'), { mode: 0o600 });
  const restarted = f.fresh();
  assert.equal((await restarted.initialize()).ok, false);
  assert.equal(
    (
      await restarted.connect({
        serverUrl: f.base,
        token: f.token,
        remember: true,
      })
    ).ok,
    true,
  );
  assert.equal((await readFile(f.file)).toString(), 'corrupt fixture');
  assert.equal((await restarted.forgetSaved()).ok, true);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

void test('CAS and lock reject other writers without losing selected credential', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const one = new ProtectedConnectionStore(f.storePath, f.cipher);
  const two = new ProtectedConnectionStore(f.storePath, f.cipher);
  const entry = (await one.load()).entry;
  await two.load();
  assert.equal(
    await one.save({ ...entry, userId: 'updated' }, () => true),
    true,
  );
  const bytes = await readFile(f.file);
  assert.equal(await two.save(entry, () => true), false);
  assert.equal(two.status().issue, 'storage_changed');
  assert.equal(await two.forget(() => true), false);
  assert.deepEqual(await readFile(f.file), bytes);
  await writeFile(join(f.storePath, 'selected.lock'), '', { mode: 0o600 });
  assert.equal(await one.save(entry, () => true), false);
  assert.equal(one.status().issue, 'storage_busy');
  assert.deepEqual(await readFile(f.file), bytes);
  await rm(join(f.storePath, 'selected.lock'));
});

void test('symlink and oversized stored files fail closed and are preserved', async (t) => {
  const f = await fixture(t);
  await mkdir(f.storePath, { mode: 0o700 });
  const outside = join(f.directory, 'outside');
  await writeFile(outside, 'unchanged');
  await symlink(outside, f.file);
  assert.equal((await f.fresh().initialize()).ok, false);
  assert.equal((await readFile(outside)).toString(), 'unchanged');
  await rm(f.file);
  const bytes = randomBytes(128 * 1024 + 1);
  await writeFile(f.file, bytes, { mode: 0o600 });
  assert.equal((await f.fresh().initialize()).ok, false);
  assert.deepEqual(await readFile(f.file), bytes);
});

void test('late startup response cannot resurrect a logged-out connection or its saved credential', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  let release;
  f.remote.gate = new Promise((resolve) => {
    release = resolve;
  });
  const restarted = f.fresh();
  const calls = f.remote.calls;
  const restoring = restarted.initialize();
  while (f.remote.calls === calls)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await restarted.logout();
  release();
  assert.equal((await restoring).ok, false);
  assert.equal(restarted.getState().data.status, 'disconnected');
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

void test('logout cancels queued encryption before commit and leaves no temporary credentials', async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  let release;
  f.control.gate = new Promise((resolve) => {
    release = resolve;
  });
  const connecting = f.connect();
  while (f.control.encryptions === 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const logout = f.service.logout();
  release();
  assert.equal((await connecting).ok, false);
  assert.equal((await logout).ok, true);
  assert.equal(f.service.getState().data.status, 'disconnected');
  assert.deepEqual(await readdir(f.storePath), []);
});

void test('explicit saved retry invalidates an active revoked credential and releases pending state after scope changes', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  const bytes = await readFile(f.file);
  f.remote.policy = 'policy-v2';
  assert.equal((await f.service.restoreSaved()).ok, false);
  assert.equal(f.service.getState().data.selection, null);
  assert.equal((await f.select()).ok, true);
  f.remote.status = 401;
  assert.equal((await f.service.restoreSaved()).ok, false);
  assert.equal(f.service.getState().data.status, 'disconnected');
  assert.ok((await readFile(f.file)).length > 0);
  assert.ok(bytes.length > 0);
});

void test('logout deletion failure clears memory but preserves stored bytes and reports retryable failure', async (t) => {
  const f = await fixture(t);
  await f.connect();
  await f.select();
  const bytes = await readFile(f.file);
  const lock = join(f.storePath, 'selected.lock');
  await writeFile(lock, '', { mode: 0o600 });
  const result = await f.service.logout();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'protection_delete_failed');
  assert.equal(f.service.getState().data.status, 'disconnected');
  assert.equal(f.service.getState().data.protection.saved, true);
  assert.deepEqual(await readFile(f.file), bytes);
  await rm(lock);
  assert.equal((await f.service.forgetSaved()).ok, true);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

void test('IPC parsers reject unknown input and strip secrets from diagnostics', () => {
  assert.deepEqual(
    parseConnectRequest({
      serverUrl: 'https://example.test',
      token: 'fixture',
      remember: true,
    }),
    { serverUrl: 'https://example.test', token: 'fixture', remember: true },
  );
  assert.throws(() =>
    parseConnectRequest({
      serverUrl: 'https://example.test',
      token: 'fixture',
      remember: 'yes',
    }),
  );
  const parsed = parseConnectionResult({
    ok: true,
    data: {
      status: 'disconnected',
      token: 'secret',
      protection: {
        availability: 'session_only',
        backend: 'unsafe_fallback',
        saved: false,
        remembered: false,
        issue: 'none',
        token: 'secret',
      },
    },
  });
  assert.equal(JSON.stringify(parsed).includes('secret'), false);
});
