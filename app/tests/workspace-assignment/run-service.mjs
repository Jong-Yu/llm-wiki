import { build } from 'vite';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const temp = await mkdtemp('/private/tmp/wiki-assignment-unit-');
try {
  await build({
    configFile: false,
    root: app,
    logLevel: 'error',
    resolve: { alias: { '@contracts': resolve(app, 'src/shared/contracts') } },
    ssr: { noExternal: true },
    build: {
      ssr: resolve(here, 'service.ts'),
      outDir: temp,
      rolldownOptions: { output: { entryFileNames: 'service.mjs' } },
    },
  });
  const result = await import(pathToFileURL(resolve(temp, 'service.mjs')).href);
  const out = resolve(app, 'test-results/workspace-assignment');
  await mkdir(out, { recursive: true });
  await writeFile(
    resolve(out, 'service.json'),
    JSON.stringify(result.default, null, 2) + '\n',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
