import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { waitForReady, stopProcess } from '../testRuntime.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp(
  join(await realpath(tmpdir()), 'wiki-voc-http-'),
);
const fixture = join(temporary, 'server');
let server;
try {
  server = spawn(
    join(project, '.venv/bin/python'),
    ['-u', join(appRoot, 'tests/poc-ui/server.py'), fixture],
    {
      cwd: project,
      env: { ...process.env, PYTHONPATH: project },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverError = '';
  server.stderr.on('data', (bytes) => {
    serverError = (serverError + bytes.toString()).slice(-4000);
  });
  const serverUrl = await waitForReady(server, {
    timeoutMessage: () => serverError || 'Isolated VOC server startup timeout',
    stoppedMessage: () => serverError || 'Isolated VOC server stopped',
  });
  const entry = join(temporary, 'entry.ts');
  await writeFile(
    entry,
    `
    export {ConnectionService} from '${join(appRoot, 'src/main/backend/ConnectionService.ts')}';
    export {createWikiBridge} from '${join(appRoot, 'src/shared/createWikiBridge.ts')}';
    export {VOC_CHANNELS} from '${join(appRoot, 'src/shared/contracts/voc.contract.ts')}';
  `,
  );
  const bundle = await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@main': join(appRoot, 'src/main'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: entry,
      write: false,
      rolldownOptions: { external: ['electron'] },
    },
  });
  const chunk = bundle.output.find((value) => value.type === 'chunk');
  assert(chunk);
  const modulePath = join(temporary, 'product.mjs');
  await writeFile(modulePath, chunk.code);
  const { ConnectionService, createWikiBridge, VOC_CHANNELS } = await import(
    pathToFileURL(modulePath).href
  );
  const service = new ConnectionService();
  const account = { serverUrl, name: '격리 오류 보고 통합 검증' };
  const signup = await service.authenticate({ ...account, mode: 'signup' });
  assert(
    signup.ok && signup.data.status === 'connected',
    'signup must succeed',
  );
  service.disconnect();
  const login = await service.authenticate({ ...account, mode: 'login' });
  assert(login.ok && login.data.status === 'connected', 'login must succeed');
  assert.equal(login.data.userId, signup.data.userId);
  assert.equal(
    login.data.selection,
    null,
    'workspace assignment is not required',
  );
  const bridge = createWikiBridge(async (channel, request) => {
    assert.equal(channel, VOC_CHANNELS.submit);
    return service.submitVoc(request);
  });
  const content =
    '  문서 등록 중 오류가 발생했습니다.\r\n재현: 파일 선택 → 보고\n"따옴표"와 끝 공백 보존  ';
  const receipt = await bridge.voc.submit({
    connectionId: login.data.connectionId,
    content,
  });
  assert(receipt.ok, 'authenticated HTTP submission must succeed');
  const directory = join(fixture, 'data/voc');
  const files = await readdir(directory);
  assert.deepEqual(files, [receipt.data.report_id + '.json']);
  const saved = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  assert.deepEqual(saved, {
    version: 1,
    report_id: receipt.data.report_id,
    created_at: receipt.data.created_at,
    user_id: login.data.userId,
    content,
  });
  assert(Number.isFinite(Date.parse(saved.created_at)));
  const requestPaths = (
    await readFile(join(fixture, 'test-request-paths.txt'), 'utf8')
  ).split('\n');
  assert.equal(requestPaths.filter((path) => path === '/api/v1/voc').length, 1);
  service.disconnect();
  console.log(
    'VOC integration passed: real signup/login → app bridge → ConnectionService → authenticated HTTP → exact data/voc JSON; one submit, no workspace required.',
  );
} finally {
  if (server) await stopProcess(server);
  await rm(temporary, { recursive: true, force: true });
}
