import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationPreview } from './navigationPreview.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const destination = process.argv[2] ?? resolve(here, 'preview.html');
const built = await build({
  configFile: false,
  root: here,
  logLevel: 'error',
  plugins: [notificationPreview(app), react()],
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
      entry: resolve(here, 'renderer.tsx'),
      name: 'NotificationApprovalPreview',
      formats: ['iife'],
    },
  },
});
const output = Array.isArray(built)
  ? built.flatMap((part) => part.output)
  : built.output;
const scripts = output
  .filter((part) => part.type === 'chunk')
  .map((part) => part.code)
  .join('\n');
const css = output
  .filter((part) => part.type === 'asset' && part.fileName.endsWith('.css'))
  .map((part) => part.source)
  .join('\n');
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none';"><title>알림 · 문자 사용 승인 시안</title><style>${css}</style></head><body><div id="notification-preview"></div><script>${scripts.replaceAll('</script', '<\\/script')}</script></body></html>`;
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, html);
console.log(JSON.stringify({ destination, bytes: Buffer.byteLength(html) }));
