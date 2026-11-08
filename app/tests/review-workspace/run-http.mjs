import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
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
    const timer = setTimeout(
      () => reject(new Error(serverError || 'Isolated server startup timeout')),
      15000,
    );
    server.stdout.on('data', (bytes) => {
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString());
      if (match) {
        clearTimeout(timer);
        accept(match[1]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timer);
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
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/review-workspace/verify-http.ts'),
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
    stdio: 'inherit',
    env: {
      ...process.env,
      WIKI_REVIEW_HTTP_URL: url,
      WIKI_REVIEW_HTTP_ROOT: temporary,
      WIKI_REVIEW_HTTP_APP: appRoot,
      ELECTRON_RUN_AS_NODE: '',
    },
  });
  let timedOut = false;
  const outcome = await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 45000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal });
    });
  });
  if (timedOut || outcome.code !== 0)
    throw new Error(
      'Review workspace HTTP verification failed: ' +
        JSON.stringify({ ...outcome, timedOut }),
    );
} finally {
  server.kill('SIGTERM');
  await new Promise((done) =>
    server.exitCode !== null ? done() : server.once('exit', done),
  );
  await rm(temporary, { recursive: true, force: true });
}
