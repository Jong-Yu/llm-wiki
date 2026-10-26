import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { UserConfig } from 'electron-vite';
import type { ConfigEnv } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = resolve(import.meta.dirname, '..');

// 빌드 단계에서 개발 예외를 제거해 제품 실행에 개발 URL/CSP를 열지 않습니다.
export default defineConfig(({ command }: ConfigEnv): UserConfig => {
  const isDevelopment = command === 'serve';
  const contracts = resolve(appRoot, 'src/shared/contracts');
  const policy = [
    "default-src 'none'",
    `script-src 'self'${isDevelopment ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${isDevelopment ? "'self' ws://127.0.0.1:5173" : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');

  return {
    main: {
      define: { __WIKI_DEV__: JSON.stringify(isDevelopment) },
      resolve: {
        alias: {
          '@contracts': contracts,
          '@main': resolve(appRoot, 'src/main'),
        },
      },
    },
    preload: {
      resolve: { alias: { '@contracts': contracts } },
      build: {
        // sandbox preload에서 외부 require 없이 IPC 계약 검증을 실행합니다.
        externalizeDeps: { exclude: ['zod'] },
        rolldownOptions: {
          output: {
            format: 'cjs',
            entryFileNames: 'index.cjs',
            codeSplitting: false,
          },
        },
      },
    },
    renderer: {
      resolve: {
        alias: {
          '@contracts': contracts,
          '@renderer': resolve(appRoot, 'src/renderer'),
        },
      },
      server: { host: '127.0.0.1', port: 5173, strictPort: true },
      plugins: [
        react(),
        {
          name: 'wiki-content-security-policy',
          transformIndexHtml: (html: string): string =>
            html.replace('__WIKI_CSP__', policy),
        },
      ],
    },
  };
});
