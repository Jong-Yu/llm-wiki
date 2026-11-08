import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startWebTestServer } from '../../src/web-test/httpServer';
import { createWebServices } from '../../src/web-test/services';
import { parseConnectionResult } from '../../src/shared/contracts/connection.contract';
import { parseDocumentListResult } from '../../src/shared/contracts/documents.contract';
import { verifyMemory } from './memory';
import { verifySourceBytes } from './sourceBytes';
import { verifyFiles } from './files';
import { verifyFileUi } from './fileUi';
import { verifyBrowserFiles } from './browserFiles';
import { verifySourceDetail } from './sourceDetail';
import {
  verifyOntologyTransportBoundaries,
  verifyOntologyWebTransport,
} from './ontologyExploration';
import { ConnectionService } from '../../src/main/backend/ConnectionService';
import { ProtectedConnectionStore } from '../../src/main/backend/ProtectedConnectionStore';
import type {
  ConnectionCipher,
  SavedConnection,
} from '../../src/main/backend/ProtectedConnectionStore';

/** PoC 기본 조회와 기존 연결 보존을 모형 응답·격리 파일에서 검사합니다. */
async function verifyWorkspaceDefault(root: string): Promise<number> {
  const originalFetch = globalThis.fetch;
  const token = 'isolated-workspace-default-token-1234567890';
  const serverUrl = 'http://127.0.0.1:41999/';
  let defaultProfile = 'default';
  let permissions = ['read', 'write', 'source_write'];
  const accessRevision = 'a'.repeat(64);
  const policyRevision = 'b'.repeat(64);
  const cipher: ConnectionCipher = {
    availability: async (): ReturnType<ConnectionCipher['availability']> => ({
      availability: 'protected',
      backend: 'macos_keychain',
    }),
    encrypt: async (plainText: string): Promise<Buffer> =>
      Buffer.from(plainText).reverse(),
    decrypt: async (encrypted: Buffer): Promise<string> =>
      Buffer.from(encrypted).reverse().toString('utf8'),
  };
  globalThis.fetch = async (): Promise<Response> =>
    Response.json({
      meta: { trace_id: 'c'.repeat(32) },
      data: {
        token,
        user_id: 'fixture-user',
        display_name: '격리 기본 설정 검증',
        default_tenant: 'fixture-workspace',
        policy_revision: policyRevision,
        access_revision: accessRevision,
        memberships: {
          'fixture-workspace': {
            permissions,
            default_profile: defaultProfile,
            profiles: {
              default: { domain: null, viewpoint: null },
              role: { domain: 'engineering', viewpoint: 'developer' },
              alternate: { domain: null, viewpoint: null },
            },
          },
        },
      },
    });
  let checks = 0;
  try {
    const service = new ConnectionService();
    const login = await service.authenticate({
      serverUrl,
      name: '격리 기본 설정 검증',
      mode: 'login',
    });
    assert(login.ok && login.data.status === 'connected');
    const connectionId = login.data.connectionId;
    assert.equal(login.data.selection?.profile, 'default');
    assert(!('ok' in (await service.analysisContext(connectionId))));
    checks++;
    const select = (
      profile: string,
    ): ReturnType<ConnectionService['selectWorkspace']> =>
      service.selectWorkspace({
        connectionId,
        tenant: 'fixture-workspace',
        profile,
      });
    for (const profile of ['role', 'alternate']) {
      const rejected = await select(profile);
      assert(!rejected.ok);
      assert.equal(rejected.error.code, 'workspace_selection_changed');
      const state = service.getState();
      assert(state.ok && state.data.status === 'connected');
      assert.equal(state.data.selection, null);
      checks++;
    }
    assert((await select('default')).ok);
    defaultProfile = 'role';
    const current = await service.analysisContext(connectionId);
    assert('ok' in current && !current.ok);
    assert.equal(current.error.code, 'workspace_default_invalid');
    const invalidLogin = await new ConnectionService().authenticate({
      serverUrl,
      name: '격리 기본 설정 검증',
      mode: 'login',
    });
    assert(!invalidLogin.ok);
    assert.equal(invalidLogin.error.code, 'workspace_default_invalid');
    const invalidSelection = await select('default');
    assert(!invalidSelection.ok);
    assert.equal(invalidSelection.error.code, 'workspace_default_invalid');
    checks++;
    defaultProfile = 'default';
    assert((await select('default')).ok);
    defaultProfile = 'alternate';
    const changed = await service.analysisContext(connectionId);
    assert('ok' in changed && !changed.ok);
    assert.equal(changed.error.code, 'workspace_selection_changed');
    checks++;
    defaultProfile = 'default';
    permissions = [];
    const denied = await select('default');
    assert(!denied.ok && denied.error.code === 'read_required');
    permissions = ['read', 'write', 'source_write'];
    checks++;

    for (const profile of ['default', 'role', 'alternate']) {
      const directory = join(root, `default-recovery-${profile}`);
      const store = new ProtectedConnectionStore(directory, cipher);
      assert((await store.load()).ok);
      const entry: SavedConnection = {
        version: 1,
        serverUrl: `${serverUrl}api/v1/`,
        token,
        userId: 'fixture-user',
        policyRevision,
        accessRevision,
        selection: {
          tenant: 'fixture-workspace',
          profile,
          domain: profile === 'role' ? 'engineering' : null,
          viewpoint: profile === 'role' ? 'developer' : null,
        },
      };
      assert(await store.save(entry, (): boolean => true));
      const saved = await readFile(join(directory, 'selected.bin'));
      const restored = await new ConnectionService(
        new ProtectedConnectionStore(directory, cipher),
      ).initialize();
      if (profile === 'default') {
        assert(restored.ok && restored.data.status === 'connected');
        assert.equal(restored.data.selection?.profile, 'default');
      } else {
        assert(!restored.ok);
        assert.equal(restored.error.code, 'workspace_selection_changed');
      }
      assert.deepEqual(await readFile(join(directory, 'selected.bin')), saved);
      checks++;
    }
    return checks;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 실제 격리 API와 Node 서비스 조합으로 Electron 없이 연결 및 웹 경계를 확인합니다. */
async function verify(): Promise<void> {
  const ontologyBoundaryChecks = await verifyOntologyTransportBoundaries();
  const memoryChecks = await verifyMemory();
  const sourceByteChecks = await verifySourceBytes();
  const fileUiChecks = await verifyFileUi();
  const browserFileChecks = await verifyBrowserFiles();
  const sourceDetailChecks = await verifySourceDetail();
  const root = process.env.WIKI_WEB_VERIFY_ROOT;
  const project = process.env.WIKI_WEB_VERIFY_PROJECT;
  const upstream = process.env.WIKI_WEB_VERIFY_URL;
  assert(root && project && upstream);
  const workspaceDefaultChecks = await verifyWorkspaceDefault(root);
  const assetsRoot = join(root, 'assets-root');
  await mkdir(join(assetsRoot, 'assets'), { recursive: true });
  await writeFile(
    join(assetsRoot, 'index.html'),
    '<!doctype html><title>test</title>',
  );
  await writeFile(join(assetsRoot, 'assets/app.js'), 'void 0;');
  await writeFile(join(root, 'private.txt'), 'must not be served');
  const services = await createWebServices(root, project, upstream);
  const server = await startWebTestServer({ assetsRoot, services, port: 0 });
  let checks = 0;
  try {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    checks++;
    assert.equal(home.headers.get('cache-control'), 'no-store');
    checks++;
    assert.match(
      home.headers.get('content-security-policy') ?? '',
      /frame-ancestors 'none'/,
    );
    checks++;
    const setCookie = home.headers.get('set-cookie');
    assert(
      setCookie &&
        setCookie.includes('HttpOnly') &&
        setCookie.includes('SameSite=Strict'),
    );
    checks++;
    const cookie = setCookie.split(';')[0];
    assert(cookie);
    const headers = {
      'Content-Type': 'application/json',
      'X-Wiki-Test-Request': '1',
      Origin: server.url,
      Cookie: cookie,
    };
    const endpoint = `${server.url}/__wiki_test/invoke`;
    const body = JSON.stringify({ channel: 'connection:get-state', args: [] });
    const post = async (channel: string, args: unknown[]): Promise<unknown> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel, args }),
      });
      assert.equal(response.status, 200);
      const result: unknown = await response.json();
      assert(!JSON.stringify(result).includes('"token"'));
      return result;
    };
    assert.equal((await fetch(endpoint)).status, 405);
    checks++;
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.invalid' },
          body,
        })
      ).status,
      403,
    );
    checks++;
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, Cookie: '' },
          body,
        })
      ).status,
      403,
    );
    checks++;
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, Origin: '' },
          body,
        })
      ).status,
      403,
    );
    checks++;
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, 'X-Wiki-Test-Request': '' },
          body,
        })
      ).status,
      403,
    );
    checks++;
    assert.equal(
      (await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status,
      400,
    );
    checks++;
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers,
          body: ' '.repeat(8 * 1024 * 1024 + 1),
        })
      ).status,
      413,
    );
    checks++;
    assert.equal((await fetch(`${server.url}/private.txt`)).status, 404);
    checks++;
    assert.equal(
      (await fetch(`${server.url}/assets/%2e%2e%2f%2e%2e%2fprivate.txt`))
        .status,
      404,
    );
    checks++;
    assert.equal((await fetch(`${server.url}/assets/app.js`)).status, 200);
    checks++;
    const disconnected = parseConnectionResult(
      await post('connection:get-state', []),
    );
    assert(disconnected.ok && disconnected.data.status === 'disconnected');
    checks++;
    const invalidChannel = await post('unexpected:execute', []);
    assert.equal(JSON.stringify(invalidChannel).includes('"ok":false'), true);
    checks++;
    const wrongServer = parseConnectionResult(
      await post('connection:authenticate', [
        {
          mode: 'login',
          name: '격리 웹 검증',
          serverUrl: 'https://example.invalid',
        },
      ]),
    );
    assert.equal(wrongServer.ok, false);
    checks++;
    const signup = parseConnectionResult(
      await post('connection:authenticate', [
        { mode: 'signup', name: '격리 웹 검증', serverUrl: upstream },
      ]),
    );
    assert(signup.ok && signup.data.status === 'connected');
    checks++;
    const connectionId = signup.data.connectionId;
    const fileChecks = await verifyFiles(
      server.url,
      headers,
      post,
      connectionId,
      services,
    );
    const ontologyWebChecks = await verifyOntologyWebTransport(
      post,
      connectionId,
    );
    const listing = parseDocumentListResult(
      await post('documents:list', [{ connectionId, cursor: null, limit: 20 }]),
    );
    assert(listing.ok);
    checks++;
    const sourceUnsupported = await post('sources:choose-file', [
      { connectionId },
    ]);
    assert.equal(
      JSON.stringify(sourceUnsupported).includes('web_test_unsupported'),
      true,
    );
    checks++;
    const logout = parseConnectionResult(
      await post('connection:disconnect', []),
    );
    assert(logout.ok && logout.data.status === 'disconnected');
    checks++;
    const stale = parseDocumentListResult(
      await post('documents:list', [{ connectionId, cursor: null, limit: 20 }]),
    );
    assert.equal(stale.ok, false);
    checks++;
    const login = parseConnectionResult(
      await post('connection:authenticate', [
        { mode: 'login', name: '격리 웹 검증', serverUrl: upstream },
      ]),
    );
    assert(login.ok && login.data.status === 'connected');
    checks++;
    const state = parseConnectionResult(await post('connection:get-state', []));
    assert(state.ok && state.data.status === 'connected');
    checks++;
    process.stdout.write(
      `웹 모드 ${checks}개, 지도 전송 ${ontologyBoundaryChecks + ontologyWebChecks}묶음, 파일 왕복·경계 ${fileChecks}개, 파일 UI ${fileUiChecks}묶음, 브라우저 취소 ${browserFileChecks}묶음, 원본 HTTP 무결성 ${sourceByteChecks}개, 원본 상세 ${sourceDetailChecks}개, 메모리 복구 ${memoryChecks}묶음, 기본 조회 ${workspaceDefaultChecks}묶음 통과\n`,
    );
  } finally {
    await server.close();
  }
}

void verify().catch((error: unknown): void => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'verification_failed'}\n`,
  );
  process.exitCode = 1;
});
