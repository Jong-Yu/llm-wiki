import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectRoot = resolve(appRoot, '..');
const socket = createServer();
await new Promise((done, reject) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', done);
});
const address = socket.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise((done, reject) =>
  socket.close((error) => (error ? reject(error) : done())),
);
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'wiki-template-service-')),
);
const api = `http://127.0.0.1:${port}/api/v1/`;
let server;
let diagnostics = '';
try {
  const program = `
import sys
from pathlib import Path
import uvicorn
from tools.initialize_server import initialize_new_server
from core.modules.access.policy import AccessPolicy
from core.runtime.application import create_application
paths = initialize_new_server(Path(sys.argv[1]) / 'server')
policy = AccessPolicy(Path(paths['access_config']), Path(paths['tenant_root']))
uvicorn.run(create_application(policy), host='127.0.0.1', port=int(sys.argv[2]), log_level='error')
`;
  server = spawn(
    join(projectRoot, '.venv/bin/python'),
    ['-c', program, temporary, String(port)],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stderr.on('data', (data) => {
    diagnostics = (diagnostics + data).slice(-8000);
  });
  server.stdout.on('data', (data) => {
    diagnostics = (diagnostics + data).slice(-8000);
  });
  const until = Date.now() + 20000;
  for (;;) {
    try {
      const response = await fetch(`${api}access-context`);
      if (response.status === 401) break;
    } catch {}
    if (server.exitCode !== null || Date.now() >= until)
      throw new Error(`test API not ready: ${diagnostics}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@main': join(appRoot, 'src/main'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
        electron: '\0template-test-electron',
      },
    },
    plugins: [
      {
        name: 'template-test-dialog',
        resolveId(source) {
          return source === 'electron' ? '\0template-test-electron' : null;
        },
        load(id) {
          return id === '\0template-test-electron'
            ? 'export const dialog = { showSaveDialog: (...args) => globalThis.__wikiTemplateSaveDialog(...args), showOpenDialog: (...args) => globalThis.__wikiTemplateOpenDialog(...args) };'
            : null;
        },
      },
    ],
    ssr: { noExternal: true },
    build: {
      ssr: join(appRoot, 'tests/templates/verify-service.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: { output: { entryFileNames: 'verify-service.mjs' } },
    },
  });
  const child = spawn(
    process.execPath,
    [join(temporary, 'verify-service.mjs')],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        WIKI_TEMPLATE_TEST_API: api,
        WIKI_TEMPLATE_TEST_ROOT: temporary,
        WIKI_TEMPLATE_TEST_PROJECT: projectRoot,
      },
      stdio: 'inherit',
    },
  );
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  assert.equal(code, 0, `TemplateService verification exited ${code}`);
} finally {
  if (server && server.exitCode === null) {
    const ended = new Promise((done) => server.once('exit', done));
    server.kill('SIGTERM');
    await ended;
  }
  await rm(temporary, { recursive: true, force: true });
}
