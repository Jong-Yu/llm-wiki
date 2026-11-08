import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-markdown-export-');
try {
  await writeFile(
    join(temporary, 'index.html'),
    '<!doctype html><title>Export checks</title>',
  );
  for (const [entry, filename, format] of [
    ['verify.ts', 'verify.mjs', 'es'],
    ['preload.ts', 'preload.cjs', 'cjs'],
  ]) {
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
        ssr: join(appRoot, 'tests/markdown-export', entry),
        outDir: temporary,
        emptyOutDir: false,
        rolldownOptions: {
          external: ['electron'],
          output: { entryFileNames: filename, format },
        },
      },
    });
  }
  const child = spawn(electron, [join(temporary, 'verify.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      WIKI_EXPORT_TEST_ROOT: temporary,
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: 'inherit',
  });
  let timedOut = false;
  const result = await new Promise((done, reject) => {
    let forceStop;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), 1500);
    }, 45000);
    const clear = () => {
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
    };
    child.once('error', (error) => {
      clear();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clear();
      done({ code, signal });
    });
  });
  if (timedOut || result.code !== 0)
    throw new Error(
      `Markdown export checks failed (code=${result.code}, signal=${result.signal}, timedOut=${timedOut})`,
    );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
