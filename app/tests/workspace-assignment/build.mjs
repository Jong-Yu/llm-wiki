import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const result = await build({
  configFile: false,
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(app, 'src/renderer'),
      '@contracts': resolve(app, 'src/shared/contracts'),
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    minify: true,
    lib: {
      entry: resolve(here, 'renderer.tsx'),
      name: 'AssignmentTest',
      formats: ['iife'],
    },
  },
});
const assets = Array.isArray(result)
  ? result.flatMap((x) => x.output)
  : result.output;
const css = assets
  .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
  .map((x) => x.source)
  .join('\n');
const js = assets
  .filter((x) => x.type === 'chunk')
  .map((x) => x.code)
  .join('\n');
await writeFile(
  process.argv[2],
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}${css}</style></head><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`,
);
