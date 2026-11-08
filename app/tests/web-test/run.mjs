import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp(
  join(await realpath(tmpdir()), 'wiki-web-verify-'),
);
const server = spawn(
  join(project, '.venv/bin/python'),
  ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(temporary, 'fixture')],
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
try {
  const url = await new Promise((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('fixture startup timeout')),
      15000,
    );
    server.stdout.on('data', (bytes) => {
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString());
      if (match) {
        clearTimeout(timeout);
        accept(match[1]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(serverError || 'fixture stopped'));
    });
  });
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@contracts': join(appRoot, 'src/shared/contracts'),
        '@main': join(appRoot, 'src/main'),
        '@renderer': join(appRoot, 'src/renderer'),
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/web-test/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  const child = spawn(process.execPath, [join(temporary, 'verify.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      WIKI_WEB_VERIFY_ROOT: temporary,
      WIKI_WEB_VERIFY_PROJECT: project,
      WIKI_WEB_VERIFY_URL: url,
    },
    stdio: 'inherit',
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0) throw new Error('Web verification failed');
} finally {
  server.kill('SIGTERM');
  await new Promise((done) =>
    server.exitCode !== null ? done() : server.once('exit', done),
  );
  await rm(temporary, { recursive: true, force: true });
}
