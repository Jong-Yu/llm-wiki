import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-diagnostic-review-');
try {
  const alias = {
    '@renderer': join(appRoot, 'src/renderer'),
    '@contracts': join(appRoot, 'src/shared/contracts'),
  };
  await build({
    configFile: false,
    root: join(appRoot, 'tests/diagnostic-review'),
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
      ssr: join(appRoot, 'tests/diagnostic-review/verify.ts'),
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
      WIKI_DIAGNOSTIC_ROOT: temporary,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  let timedOut = false;
  const outcome = await new Promise((done, reject) => {
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
  if (timedOut || outcome.code !== 0)
    throw new Error(
      'Diagnostic review verification failed: ' +
        JSON.stringify({ ...outcome, timedOut }),
    );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
