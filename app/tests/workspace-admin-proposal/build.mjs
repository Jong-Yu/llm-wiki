import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const destination = process.argv[2];
const entry = process.argv[3] ?? 'renderer.tsx';
if (!destination) throw new Error('출력 fragment 절대 경로가 필요합니다.');
const built = await build({
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
    cssMinify: true,
    assetsInlineLimit: 1000000,
    lib: {
      entry: resolve(here, entry),
      name: 'WorkspaceAdminProposal',
      formats: ['iife'],
    },
  },
});
const output = Array.isArray(built)
  ? built.flatMap((item) => item.output)
  : built.output;
const scripts = output
  .filter((file) => file.type === 'chunk')
  .map((file) => file.code)
  .join('\n');
const styles = output
  .filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'))
  .map((file) => file.source)
  .join('\n');
const fragment = (await readFile(resolve(here, 'fragment.html'), 'utf8'))
  .replace('<!-- ADMIN_STYLE -->', () => `<style>${styles}</style>`)
  .replace(
    '<!-- ADMIN_SCRIPT -->',
    () => `<script>${scripts.replaceAll('</script', '<\\/script')}</script>`,
  );
if (Buffer.byteLength(fragment) >= 1000000) throw new Error('1 MB 제한 초과');
await writeFile(destination, fragment);
console.log(
  JSON.stringify({ destination, bytes: Buffer.byteLength(fragment) }),
);
