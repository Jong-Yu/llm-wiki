import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await realpath(
  await mkdtemp('/private/tmp/wiki-document-tasks-'),
);
try {
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
      ssr: join(appRoot, 'tests/document-tasks-backend/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  const child = spawn(process.execPath, [join(temporary, 'verify.mjs')], {
    cwd: appRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      WIKI_TASK_TEST_ROOT: temporary,
      WIKI_TASK_TEST_PYTHON: join(appRoot, '../.venv/bin/python'),
    },
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0)
    throw new Error(`Document workflow backend checks failed: ${code}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
