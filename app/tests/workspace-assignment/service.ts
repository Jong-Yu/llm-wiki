import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectionService } from '../../src/main/backend/ConnectionService';
import { ProtectedConnectionStore } from '../../src/main/backend/ProtectedConnectionStore';
import type {
  ConnectionCipher,
  SavedConnection,
} from '../../src/main/backend/ProtectedConnectionStore';
import type {
  ConnectionResult,
  ConnectionSnapshot,
} from '../../src/shared/contracts/connection.contract';
const originalFetch = globalThis.fetch;
const root = await mkdtemp('/private/tmp/wiki-assignment-service-');
const token = 'isolated-waiting-account-token-123456789012';
let assigned = false;
let defaultTenant: string | null = 'research';
let revision = 'a'.repeat(64);
let permissions = ['read'];
let domain: string | null = null;
let userId = 'waiting-user';
let status = 200;
let networkError = false;
let deferred: Promise<void> | null = null;
const requests: { path: string; authenticated: boolean }[] = [];
const checks: string[] = [];
const cipher: ConnectionCipher = {
  availability: async (): ReturnType<ConnectionCipher['availability']> => ({
    availability: 'protected',
    backend: 'macos_keychain',
  }),
  encrypt: async (plain: string): Promise<Buffer> =>
    Buffer.from(plain).reverse(),
  decrypt: async (bytes: Buffer): Promise<string> =>
    Buffer.from(bytes).reverse().toString('utf8'),
};
/** 공개 응답에 비밀이 없는 연결만 돌려줍니다. */
function connected(
  result: ConnectionResult,
): Extract<ConnectionSnapshot, { status: 'connected' }> {
  assert(result.ok && result.data.status === 'connected');
  assert(!JSON.stringify(result).includes(token));
  return result.data;
}
/** 가입·재확인에 동일한 서버 범위 모형을 제공합니다. */
function envelope(): unknown {
  return {
    meta: { trace_id: 'c'.repeat(32) },
    data: {
      token,
      user_id: userId,
      display_name: '대기 사용자',
      default_tenant: assigned ? defaultTenant : null,
      policy_revision: 'b'.repeat(64),
      access_revision: revision,
      memberships: assigned
        ? {
            research: {
              display_name: '연구',
              permissions,
              default_profile: 'default',
              profiles: { default: { domain, viewpoint: null } },
            },
          }
        : {},
    },
  };
}
globalThis.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  requests.push({
    path: String(input),
    authenticated:
      new Headers(init?.headers).get('Authorization') === `Bearer ${token}`,
  });
  if (deferred) await deferred;
  if (networkError) throw new TypeError('isolated network failure');
  return status === 200
    ? Response.json(envelope())
    : Response.json(
        { error: { code: 'unauthorized', message: 'denied' } },
        { status },
      );
};
try {
  const directory = join(root, 'waiting');
  const store = new ProtectedConnectionStore(directory, cipher);
  const service = new ConnectionService(store);
  const account = {
    serverUrl: 'http://127.0.0.1:41999/',
    name: '대기 사용자',
    mode: 'signup' as const,
  };
  const signup = connected(await service.authenticate(account));
  assert.deepEqual(signup.workspaces, []);
  assert.equal(signup.selection, null);
  assert.equal(service.localContext(), null);
  assert.equal(signup.protection?.remembered, true);
  const saved = await store.load();
  assert(saved.ok && saved.entry);
  assert.equal(saved.entry.awaitingWorkspaceAssignment, true);
  const savedBytes = await readFile(join(directory, 'selected.bin'));
  assert(!savedBytes.includes(Buffer.from(token)));
  const calls = requests.length;
  service.getState();
  assert.equal(requests.length, calls);
  connected(await service.refreshAccess());
  assert(requests.at(-1)?.authenticated);
  assert(requests.at(-1)?.path.endsWith('/access-context'));
  assert.equal(connected(service.getState()).selection, null);
  checks.push(
    '무소속 가입/명시 재확인: 토큰 비노출·보호 저장·null 선택, 업무 문맥 없음, getState 무통신',
  );

  networkError = true;
  const offline = await service.refreshAccess();
  assert(!offline.ok);
  assert.equal(connected(service.getState()).connectionId, signup.connectionId);
  networkError = false;
  assigned = true;
  revision = 'd'.repeat(64);
  defaultTenant = null;
  assert(!(await service.refreshAccess()).ok);
  assert.deepEqual(connected(service.getState()).workspaces, []);
  defaultTenant = 'research';
  permissions = [];
  assert(!(await service.refreshAccess()).ok);
  assert.equal(connected(service.getState()).selection, null);
  permissions = ['read'];
  domain = 'engineering';
  assert(!(await service.refreshAccess()).ok);
  domain = null;
  const accepted = connected(await service.refreshAccess());
  assert.deepEqual(accepted.selection, {
    tenant: 'research',
    profile: 'default',
  });
  assert.equal(accepted.connectionId, signup.connectionId);
  const updated = await store.load();
  assert(updated.ok && updated.entry);
  assert.equal(updated.entry.awaitingWorkspaceAssignment, undefined);
  checks.push(
    '재확인 오류 시 대기/토큰 유지, null default·읽기 없음·비중립 profile 거부, 정상 서버 기본 배정만 진입',
  );

  // 실제 대기 상태에서 저장한 암호문을 다른 프로세스의 저장 파일처럼 복원합니다.
  const restartDir = join(root, 'restart');
  await mkdir(restartDir, { mode: 0o700 });
  await writeFile(join(restartDir, 'selected.bin'), savedBytes, {
    mode: 0o600,
  });
  const restarted = new ConnectionService(
    new ProtectedConnectionStore(restartDir, cipher),
  );
  assert.equal(
    connected(await restarted.initialize()).selection?.tenant,
    'research',
  );
  const strictBytes = await readFile(join(directory, 'selected.bin'));
  revision = 'e'.repeat(64);
  const strict = await new ConnectionService(
    new ProtectedConnectionStore(directory, cipher),
  ).initialize();
  assert(!strict.ok && strict.error.code === 'access_changed');
  assert.deepEqual(
    await readFile(join(directory, 'selected.bin')),
    strictBytes,
  );
  const changedSelected = await service.refreshAccess();
  assert(
    !changedSelected.ok && changedSelected.error.code === 'access_changed',
  );
  assert.equal(connected(service.getState()).selection, null);
  assert.deepEqual(
    await readFile(join(directory, 'selected.bin')),
    strictBytes,
  );

  const legacyDir = join(root, 'legacy');
  const legacyStore = new ProtectedConnectionStore(legacyDir, cipher);
  await legacyStore.load();
  const legacy: SavedConnection = {
    ...saved.entry,
    awaitingWorkspaceAssignment: undefined,
  };
  assert(await legacyStore.save(legacy, (): boolean => true));
  const legacyRestore = await new ConnectionService(
    new ProtectedConnectionStore(legacyDir, cipher),
  ).initialize();
  assert(!legacyRestore.ok && legacyRestore.error.code === 'access_changed');
  revision = 'a'.repeat(64);
  assigned = false;
  const oldCompatible = await new ConnectionService(
    new ProtectedConnectionStore(legacyDir, cipher),
  ).initialize();
  assert.equal(connected(oldCompatible).selection, null);
  checks.push(
    '대기 표식 저장은 재시작 후 최신 배정 수용, 선택된/legacy 미선택 revision 변경 차단·기존 파일 보존·기존 형식 호환',
  );

  const malformedDir = join(root, 'malformed');
  await mkdir(malformedDir, { mode: 0o700 });
  await writeFile(
    join(malformedDir, 'selected.bin'),
    await cipher.encrypt(
      JSON.stringify({
        ...saved.entry,
        selection: {
          tenant: 'research',
          profile: 'default',
          domain: null,
          viewpoint: null,
        },
      }),
    ),
    { mode: 0o600 },
  );
  assert.equal(
    (await new ProtectedConnectionStore(malformedDir, cipher).load()).ok,
    false,
  );
  checks.push('대기 표식과 non-null 선택의 모순 조합 거부');

  const late = new ConnectionService();
  connected(await late.authenticate({ ...account, mode: 'login' }));
  let release: () => void = (): void => {};
  deferred = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  const pending = late.refreshAccess();
  await Promise.resolve();
  await late.logout();
  release();
  await pending;
  deferred = null;
  const after = late.getState();
  assert(after.ok && after.data.status === 'disconnected');
  const denied = new ConnectionService();
  connected(await denied.authenticate({ ...account, mode: 'login' }));
  status = 401;
  const deniedResult = await denied.refreshAccess();
  assert(!deniedResult.ok);
  const deniedState = denied.getState();
  assert(deniedState.ok && deniedState.data.status === 'disconnected');
  status = 200;
  const changed = new ConnectionService();
  connected(await changed.authenticate({ ...account, mode: 'login' }));
  userId = 'other-user';
  assert(!(await changed.refreshAccess()).ok);
  const changedState = changed.getState();
  assert(changedState.ok && changedState.data.status === 'disconnected');
  checks.push(
    '지연 재확인 뒤 로그아웃 유지, 401과 인증 사용자 변경 시 연결 차단',
  );
  console.log(
    JSON.stringify(
      { passed: true, checks, requests: requests.length },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

export default { passed: true, checks, requests: requests.length };
