import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'electron';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-job-ia-');
try {
  const alias = {
    '@renderer': join(appRoot, 'src/renderer'),
    '@contracts': join(appRoot, 'src/shared/contracts'),
  };
  await build({
    configFile: false,
    root: join(appRoot, 'tests/job-navigation'),
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
      ssr: join(appRoot, 'tests/job-navigation/verify.ts'),
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
      WIKI_JOB_IA_ROOT: temporary,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  const outcome = await new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  if (outcome.code !== 0)
    throw new Error(
      'Analysis job IA verification failed: ' + JSON.stringify(outcome),
    );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
