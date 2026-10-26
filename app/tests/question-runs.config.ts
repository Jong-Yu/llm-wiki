import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: 'question-runs.spec.ts',
  tsconfig: '../config/typescript/tsconfig.tools.json',
  outputDir:
    process.env.WIKI_QUESTION_TEST_OUTPUT ||
    mkdtempSync(join(tmpdir(), 'wiki-question-test-')),
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
});
