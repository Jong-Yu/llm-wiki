import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp('/private/tmp/wiki-review-ui-');
await writeFile(
  join(temporary, 'review-test-root'),
  'isolated-review-ui-only',
  { flag: 'wx' },
);
const server = spawn(
  join(project, '.venv/bin/python'),
  [
    '-u',
    join(appRoot, 'tests/ontology-review/server.py'),
    join(temporary, 'server'),
  ],
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
      () => reject(new Error(serverError || 'Isolated server startup timeout')),
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
  // 현재 제품 renderer 설정으로 격리 산출물을 만들어 다른 작업의 out 빌드와 경합하지 않습니다.
  const productConfig = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    join(appRoot, 'config/electron.vite.config.ts'),
  );
  if (!productConfig?.config.renderer)
    throw new Error('Product renderer configuration unavailable');
  await build({
    ...productConfig.config.renderer,
    configFile: false,
    root: join(appRoot, 'src/renderer'),
    base: './',
    logLevel: 'error',
    build: { outDir: join(temporary, 'renderer') },
  });
  await build({
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
      ssr: join(appRoot, 'tests/ontology-review/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  const child = spawn(electron, [join(temporary, 'verify.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      WIKI_REVIEW_URL: url,
      WIKI_REVIEW_ROOT: temporary,
      WIKI_REVIEW_APP: appRoot,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  const code = await new Promise((done) => child.once('exit', done));
  if (code !== 0) throw new Error(`Relation review checks failed (${code})`);
} finally {
  server.kill('SIGTERM');
  await new Promise((done) =>
    server.exitCode !== null ? done() : server.once('exit', done),
  );
  await rm(temporary, { recursive: true, force: true });
}
