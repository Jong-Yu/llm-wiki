import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-error-report-');
try {
  const alias = {
    '@contracts': join(appRoot, 'src/shared/contracts'),
    '@renderer': join(appRoot, 'src/renderer'),
  };
  await build({
    configFile: false,
    root: join(appRoot, 'tests/error-report'),
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
      ssr: join(appRoot, 'tests/error-report/verify.ts'),
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
      WIKI_VOC_UI_ROOT: temporary,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  const outcome = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveCode({ code, signal }));
  });
  if (outcome.code !== 0)
    throw new Error(
      'Error report UI checks failed: ' + JSON.stringify(outcome),
    );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
