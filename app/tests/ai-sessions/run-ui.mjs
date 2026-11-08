import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'electron';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-session-ui-');
try {
  const alias = {
    '@contracts': join(appRoot, 'src/shared/contracts'),
    '@renderer': join(appRoot, 'src/renderer'),
  };
  await build({
    configFile: false,
    root: join(appRoot, 'tests/ai-sessions'),
    base: './',
    logLevel: 'error',
    resolve: { alias },
    plugins: [react()],
    build: { outDir: join(temporary, 'renderer') },
  });
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: { alias },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/ai-sessions/verify-ui.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify-ui.mjs' },
      },
    },
  });
  const child = spawn(electron, [join(temporary, 'verify-ui.mjs')], {
    env: {
      ...process.env,
      WIKI_SESSION_UI_ROOT: temporary,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0) throw new Error('AI session UI checks failed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
