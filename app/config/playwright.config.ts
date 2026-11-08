import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 실제 Electron 앱과 가짜 AI CLI로 채팅 흐름을 검증하며 결과 캡처를 test-results/chat에 남깁니다. */
export default defineConfig({
  testDir: resolve(appRoot, 'tests/chat-e2e'),
  testMatch: '**/*.spec.ts',
  outputDir: resolve(appRoot, 'test-results/chat'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: resolve(appRoot, 'test-results/chat-report'),
        open: 'never',
      },
    ],
  ],
});
