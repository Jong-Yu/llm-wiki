import { cp, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp('/private/tmp/wiki-navigation-ui-');
const product = join(temporary, 'product');
await cp(join(appRoot, 'out'), join(product, 'out'), { recursive: true });
const server = spawn(
  join(project, '.venv/bin/python'),
  ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(temporary, 'server')],
  {
    cwd: project,
    env: { ...process.env, PYTHONPATH: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverError = '';
server.stderr.on('data', (data) => {
  serverError += data.toString();
});
try {
  const url = await new Promise((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Isolated server startup timeout')),
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
      reject(new Error(serverError || 'Isolated server stopped'));
    });
  });
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@main': join(appRoot, 'src/main'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
        '@renderer': join(appRoot, 'src/renderer'),
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/navigation/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  for (const phase of ['verify']) {
    const child = spawn(electron, [join(temporary, 'verify.mjs')], {
      cwd: appRoot,
      env: {
        ...process.env,
        WIKI_UI_TEST_PHASE: phase,
        WIKI_UI_TEST_URL: url,
        WIKI_UI_TEST_ROOT: temporary,
        WIKI_UI_APP_ROOT: product,
        WIKI_CLIENT_ROOT: project,
        WIKI_PYTHON: join(project, '.venv/bin/python'),
        ELECTRON_RUN_AS_NODE: '',
      },
      stdio: 'inherit',
    });
    const code = await new Promise((done) => child.once('exit', done));
    if (code !== 0)
      throw new Error(`Navigation checks failed (${phase}: ${code})`);
  }
} finally {
  server.kill('SIGTERM');
  await new Promise((done) =>
    server.exitCode !== null ? done() : server.once('exit', done),
  );
  await rm(temporary, { recursive: true, force: true });
}
