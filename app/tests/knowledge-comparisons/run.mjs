import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-comparison-check-');
try {
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
      ssr: join(appRoot, 'tests/knowledge-comparisons/verify.ts'),
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
    env: {
      ...process.env,
      WIKI_COMPARISON_TEST_ROOT: temporary,
      WIKI_COMPARISON_PYTHON: join(appRoot, '../.venv/bin/python'),
    },
    stdio: 'inherit',
  });
  const code = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', done);
  });
  if (code !== 0) throw new Error(`Comparison verification: ${code}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
