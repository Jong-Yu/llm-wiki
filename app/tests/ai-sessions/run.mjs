import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-session-check-');
try {
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@contracts': join(appRoot, 'src/shared/contracts'),
        '@renderer': join(appRoot, 'src/renderer'),
      },
    },
    ssr: { noExternal: true },
    build: {
      ssr: join(appRoot, 'tests/ai-sessions/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: { output: { entryFileNames: 'verify.mjs' } },
    },
  });
  const child = spawn(process.execPath, [join(temporary, 'verify.mjs')], {
    stdio: 'inherit',
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0) throw new Error('AI session checks failed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
