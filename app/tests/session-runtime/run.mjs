import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-runtime-check-');
try {
  for (const target of process.argv.includes('--boundaries')
    ? ['boundaries']
    : process.argv.includes('--web-search')
      ? ['web-research']
      : process.argv.includes('--live-usage')
        ? ['live-usage']
        : ['verify', 'lifetime', 'cli-connection']) {
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
        ssr: join(appRoot, `tests/session-runtime/${target}.ts`),
        outDir: temporary,
        emptyOutDir: false,
        rolldownOptions: {
          external: ['electron'],
          output: { entryFileNames: `${target}.mjs` },
        },
      },
    });
    const child = spawn(
      target === 'lifetime' ? electron : process.execPath,
      [join(temporary, `${target}.mjs`)],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '',
          WIKI_RUNTIME_TEST_ROOT: temporary,
          WIKI_RUNTIME_PYTHON: join(appRoot, '../.venv/bin/python'),
        },
        stdio: 'inherit',
      },
    );
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`${target}: ${code}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
