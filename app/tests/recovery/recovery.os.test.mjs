import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { rolldown } from 'rolldown';
import electronPath from 'electron';

// 실제 OS 암호화·별도 Electron 프로세스만 사용하고 운영 앱 userData를 읽지 않습니다.
void test(
  'actual Electron kill/restart: auth-gated draft/pending/report recovery, CAS and crash-write preservation',
  { timeout: 60_000 },
  async () => {
    const root = resolve(import.meta.dirname, '../..');
    const directory = await mkdtemp(join(tmpdir(), 'wiki-recovery-os-'));
    const token = randomBytes(32).toString('hex');
    let denied = false;
    let accessReads = 0;
    const methods = [];
    const server = createServer((request, response) => {
      methods.push(request.method);
      accessReads++;
      response.writeHead(
        !denied && request.headers.authorization === `Bearer ${token}`
          ? 200
          : 403,
        { 'Content-Type': 'application/json' },
      );
      response.end(
        JSON.stringify({
          data: {
            user_id: 'recovery-fixture',
            policy_revision: 'a'.repeat(64),
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
        input: 'recovery-os-entry',
        platform: 'node',
        external: ['electron'],
        resolve: {
          alias: { '@contracts': join(root, 'src/shared/contracts') },
        },
        plugins: [
          {
            name: 'recovery-os-entry',
            resolveId(id) {
              if (id === 'recovery-os-entry') return '\0entry';
            },
            load(id) {
              if (id === '\0entry')
                return [
                  ['ConnectionService', 'ConnectionService.ts'],
                  ['createConnectionCipher', 'connectionProtection.ts'],
                  ['ProtectedRecoveryStore', 'ProtectedRecoveryStore.ts'],
                  ['RecoveryService', 'RecoveryService.ts'],
                ]
                  .map(
                    ([name, file]) =>
                      `export { ${name} } from ${JSON.stringify(join(root, 'src/main/backend', file))};`,
                  )
                  .join('\n');
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
const {app}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
let input='';process.stdin.setEncoding('utf8');const supplied=new Promise(resolve=>{process.stdin.on('data',value=>input+=value);process.stdin.on('end',()=>resolve(JSON.parse(input)));});
void app.whenReady().then(async()=>{
  const {ConnectionService,createConnectionCipher,ProtectedRecoveryStore,RecoveryService}=await import(${JSON.stringify(pathToFileURL(compiled).href)});
  const args=await supplied;const connection=new ConnectionService();const cipher=createConnectionCipher();
  const originalEncrypt=cipher.encrypt;
  if(args.mode==='crash-write')cipher.encrypt=async(text)=>{process.stdout.write('RECOVERY_KILL_NOW\\n');await new Promise(()=>{});return originalEncrypt(text);};
  if(args.mode==='fail-write')cipher.encrypt=async()=>{throw new Error('fixture write failure');};
  const store=new ProtectedRecoveryStore(${JSON.stringify(join(directory, 'profile/work-recovery'))},cipher);const service=new RecoveryService(connection,store);
  const expectedScope={userId:'recovery-fixture',tenant:'fixture',profileId:'all',policyRevision:'a'.repeat(64)};
  const before=await service.execute({connectionId:'not-authenticated',expectedScope,operation:'list',kind:'result-drafts'});
  const connected=await connection.connect({serverUrl:args.url,token:args.token});
  if(!connected.ok||connected.data.status!=='connected'){process.stdout.write('RECOVERY_RESULT:'+JSON.stringify({before,denied:true})+'\\n');app.quit();return;}
  const connectionId=connected.data.connectionId;await connection.selectWorkspace({connectionId,tenant:'fixture',profile:'all'});
  const base={connectionId,expectedScope};let result;
  if(['write','update','stale','crash-write','fail-write'].includes(args.mode)){
    result=await service.execute({...base,operation:'put',kind:'result-drafts',key:'workspace',payload:JSON.stringify({content:args.mode==='update'?'newer':'종료 전 편집 초안',expectedRevision:'b'.repeat(64),requestId:'c'.repeat(32),requestHash:'d'.repeat(64),receipt:{operation:'receipt',requestId:'c'.repeat(32)}}),expectedRevision:args.revision||null});
    if(args.mode==='write'){
      const report=await service.execute({...base,operation:'put',kind:'source-conversions',key:'source-v1',payload:JSON.stringify({reportId:'e'.repeat(32),sourceVersion:'f'.repeat(64),receiptState:'unconfirmed'}),expectedRevision:null});
      if(!report.ok)throw new Error('report_save_failed');
    }
  }else result=await service.execute({...base,operation:'list',kind:'result-drafts'});
  const reports=await service.execute({...base,operation:'list',kind:'source-conversions'});
  process.stdout.write('RECOVERY_RESULT:'+JSON.stringify({before,result,reports,availability:await cipher.availability()})+'\\n');
  if(args.mode==='write'){setInterval(()=>{},1000);return;}
  app.quit();
}).catch(()=>{process.stderr.write('recovery_probe_failed\\n');app.exit(1);});
`,
        { mode: 0o600 },
      );
      async function launch(mode, revision) {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(electronPath, [entry], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let killed = false;
        const exited = once(child, 'exit');
        const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (
            (mode === 'write' && stdout.includes('RECOVERY_RESULT:')) ||
            (mode === 'crash-write' && stdout.includes('RECOVERY_KILL_NOW'))
          ) {
            killed = true;
            child.kill('SIGKILL');
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.stdin.end(
          JSON.stringify({
            mode,
            revision,
            token,
            url: `http://127.0.0.1:${server.address().port}`,
          }),
        );
        const [code, signal] = await exited;
        clearTimeout(timer);
        assert.equal(
          stdout.includes(token) || stderr.includes(token),
          false,
          'no credential in probe output',
        );
        if (killed) {
          assert.equal(signal, 'SIGKILL');
        } else
          assert.equal(
            code,
            0,
            'actual Electron probe failed without echoing raw diagnostics',
          );
        if (mode === 'crash-write') {
          assert.equal(killed, true);
          return null;
        }
        const line = stdout
          .split('\n')
          .find((value) => value.startsWith('RECOVERY_RESULT:'));
        assert.ok(line);
        return JSON.parse(line.slice('RECOVERY_RESULT:'.length));
      }
      const written = await launch('write');
      assert.equal(written.before.ok, false);
      assert.equal(written.result.ok, true);
      assert.equal(written.availability.availability, 'protected');
      const original = written.result.data.entries[0];
      const identity = (
        await readdir(join(directory, 'profile/work-recovery'))
      )[0];
      const files = await readdir(
        join(directory, 'profile/work-recovery', identity),
      );
      const path = join(
        directory,
        'profile/work-recovery',
        identity,
        files.find((name) => name.endsWith('.bin')),
      );
      const initialBytes = await readFile(path);
      assert.equal(initialBytes.includes('종료 전'), false);
      assert.equal(initialBytes.includes(token), false);
      const beforeReads = accessReads;
      const restored = await launch('restore');
      assert.equal(restored.before.ok, false);
      assert.ok(accessReads > beforeReads);
      assert.deepEqual(restored.result.data.entries, [original]);
      assert.equal(restored.reports.data.entries.length, 1);
      const updated = await launch('update', original.revision);
      assert.equal(updated.result.ok, true);
      const bytes = await readFile(path);
      const stale = await launch('stale', original.revision);
      assert.equal(stale.result.error.code, 'recovery_conflict');
      assert.deepEqual(await readFile(path), bytes);
      const failed = await launch(
        'fail-write',
        updated.result.data.entries[0].revision,
      );
      assert.equal(failed.result.ok, false);
      assert.deepEqual(await readFile(path), bytes);
      denied = true;
      const revoked = await launch('restore');
      assert.equal(revoked.denied, true);
      assert.equal(revoked.result, undefined);
      assert.deepEqual(await readFile(path), bytes);
      denied = false;
      await launch('crash-write', updated.result.data.entries[0].revision);
      assert.deepEqual(await readFile(path), bytes);
      const afterCrash = await launch('restore');
      assert.equal(
        afterCrash.result.data.entries[0].revision,
        updated.result.data.entries[0].revision,
      );
      assert.equal(
        JSON.parse(afterCrash.result.data.entries[0].payload).content,
        'newer',
      );
      assert.ok((await readdir(resolve(path, '..'))).includes('records.lock'));
      assert.ok(methods.length > 0);
      assert.ok(
        methods.every((method) => method === 'GET'),
        'recovery never sends a write or restarts AI',
      );
      console.log(
        `Actual ${written.availability.backend}: committed process SIGKILL, fresh authenticated restart, stale CAS, failed encryption, denied access, and SIGKILL during write verified.`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
