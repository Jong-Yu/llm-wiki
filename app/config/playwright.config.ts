import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../tests/e2e',
  tsconfig: './typescript/tsconfig.tools.json',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
