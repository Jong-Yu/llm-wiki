import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { rolldown } from 'rolldown';
import electronPath from 'electron';

// 실제 설치된 Electron의 OS 보호 저장을 사용합니다. 운영 앱 프로필과 자료에는 접근하지 않습니다.
void test(
  'actual Electron OS encryption persists selection and fresh process rechecks server before restore',
  { timeout: 45_000 },
  async () => {
    const root = resolve(import.meta.dirname, '../..');
    const directory = await mkdtemp(join(tmpdir(), 'wiki-protection-os-'));
    const token = randomBytes(32).toString('hex');
    let reads = 0;
    const server = createServer((request, response) => {
      reads += 1;
      response.writeHead(
        request.headers.authorization === `Bearer ${token}` ? 200 : 401,
        { 'Content-Type': 'application/json' },
      );
      response.end(
        JSON.stringify({
          data: {
            user_id: 'os-fixture',
            policy_revision: 'fixture-v1',
            memberships: {
              fixture: {
                permissions: ['read'],
                default_profile: 'all',
                profiles: { all: { domain: null, viewpoint: null } },
              },
            },
          },
          meta: { trace_id: 'f'.repeat(32) },
        }),
      );
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const bundle = await rolldown({
        input: 'os-protection-entry',
        platform: 'node',
        external: ['electron'],
        resolve: {
          alias: { '@contracts': join(root, 'src/shared/contracts') },
        },
        plugins: [
          {
            name: 'os-protection-entry',
            resolveId(id) {
              if (id === 'os-protection-entry') return '\0os-protection-entry';
            },
            load(id) {
              if (id === '\0os-protection-entry')
                return `export { ConnectionService } from ${JSON.stringify(join(root, 'src/main/backend/ConnectionService.ts'))}; export { createConnectionProtection } from ${JSON.stringify(join(root, 'src/main/backend/connectionProtection.ts'))};`;
            },
          },
        ],
      });
      const compiled = join(directory, 'service.mjs');
      await bundle.write({ file: compiled, format: 'esm' });
      await bundle.close();
      const entry = join(directory, 'entry.cjs');
      await writeFile(
        entry,
        `
const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
let input = ''; process.stdin.setEncoding('utf8');
const supplied = new Promise(resolve => { process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => resolve(JSON.parse(input))); });
void app.whenReady().then(async () => {
  const { ConnectionService, createConnectionProtection } = await import(${JSON.stringify(pathToFileURL(compiled).href)});
  const args = await supplied;
  const service = new ConnectionService(createConnectionProtection(app.getPath('userData')));
  const initialized = await service.initialize();
  if (args.mode === 'save') {
    const result = await service.connect({ serverUrl: args.url, token: args.token, remember: true });
    if (!result.ok || result.data.status !== 'connected') throw new Error('fixture_connection_failed');
    await service.selectWorkspace({ connectionId: result.data.connectionId, tenant: 'fixture', profile: 'all' });
  }
  const result = service.getState();
  process.stdout.write('PROTECTION_RESULT:' + JSON.stringify({ result, initializedOk: initialized.ok }) + '\\n');
  service.disconnect(); app.quit();
}).catch(() => { process.stderr.write('protection_probe_failed\\n'); app.exit(1); });
`,
        { mode: 0o600 },
      );
      const launch = async (mode) => {
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const child = spawn(electronPath, [entry], {
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.stdin.end(
          JSON.stringify({
            mode,
            token,
            url: `http://127.0.0.1:${server.address().port}`,
          }),
        );
        const [code] = await once(child, 'exit');
        clearTimeout(timer);
        assert.equal(stdout.includes(token), false);
        assert.equal(stderr.includes(token), false);
        assert.equal(
          code,
          0,
          'Electron probe did not complete; no secret output is included',
        );
        const line = stdout
          .split('\n')
          .find((item) => item.startsWith('PROTECTION_RESULT:'));
        assert.ok(line, 'Electron probe did not return a public status');
        return JSON.parse(line.slice('PROTECTION_RESULT:'.length));
      };
      const first = await launch('save');
      assert.equal(
        first.result.data.protection.availability,
        'protected',
        'Actual OS protection unavailable; this is not an OS pass',
      );
      assert.equal(first.result.data.protection.remembered, true);
      const file = join(
        directory,
        'profile/connection-protection/selected.bin',
      );
      const bytes = await readFile(file);
      assert.equal(bytes.includes(token), false);
      const priorReads = reads;
      const next = await launch('restore');
      assert.equal(next.initializedOk, true);
      assert.equal(reads, priorReads + 1);
      assert.equal(next.result.data.userId, 'os-fixture');
      assert.deepEqual(next.result.data.selection, {
        tenant: 'fixture',
        profile: 'all',
      });
      assert.equal(next.result.data.protection.remembered, true);
      assert.deepEqual(await readFile(file), bytes);
      console.log(
        `Verified OS protection backend: ${next.result.data.protection.backend}; two fresh Electron processes and current HTTP authority.`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
