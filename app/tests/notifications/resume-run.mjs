import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp('/private/tmp/wiki-reviewed-resume-');
try {
  await build({
    configFile: false,
    root: app,
    logLevel: 'error',
    resolve: {
      alias: {
        '@renderer': join(app, 'src/renderer'),
        '@contracts': join(app, 'src/shared/contracts'),
      },
    },
    ssr: { noExternal: true },
    build: {
      ssr: join(app, 'tests/notifications/resume-registration.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: { output: { entryFileNames: 'verify.mjs' } },
    },
  });
  await import(pathToFileURL(join(temporary, 'verify.mjs')).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
