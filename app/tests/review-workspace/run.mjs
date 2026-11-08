import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-review-workspace-');
const captureDirectory =
  process.env.WIKI_REVIEW_CAPTURE_DIR ??
  (await mkdtemp('/private/tmp/wiki-review-workspace-captures-'));
try {
  const alias = {
    '@renderer': join(appRoot, 'src/renderer'),
    '@contracts': join(appRoot, 'src/shared/contracts'),
  };
  await build({
    configFile: false,
    root: join(appRoot, 'tests/review-workspace'),
    base: './',
    logLevel: 'error',
    resolve: { alias },
    plugins: [react()],
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    build: { outDir: join(temporary, 'renderer') },
  });
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: { alias },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/review-workspace/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  const child = spawn(electron, [join(temporary, 'verify.mjs')], {
    env: {
      ...process.env,
      WIKI_REVIEW_ROOT: temporary,
      WIKI_REVIEW_CAPTURE_DIR: captureDirectory,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  let timedOut = false;
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGKILL');
      },
      process.env.WIKI_A11Y === '1' ? 180000 : 45000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal });
    });
  });
  if (timedOut || result.code !== 0)
    throw new Error(
      'Review workspace verification failed: ' +
        JSON.stringify({ ...result, timedOut }),
    );
  console.log('Captures: ' + captureDirectory);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
