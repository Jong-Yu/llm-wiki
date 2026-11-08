import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-on-demand-app-');
try {
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@main': join(appRoot, 'src/main'),
        '@renderer': join(appRoot, 'src/renderer'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
      },
    },
    ssr: { noExternal: true },
    build: {
      ssr: join(appRoot, 'tests/on-demand-question/verify.ts'),
      outDir: temporary,
      rolldownOptions: { output: { entryFileNames: 'verify.mjs' } },
    },
  });
  const child = spawn(process.execPath, [join(temporary, 'verify.mjs')], {
    cwd: appRoot,
    stdio: 'inherit',
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0)
    throw new Error(`On-demand app contract verification: ${code}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
