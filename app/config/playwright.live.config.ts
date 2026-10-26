import { defineConfig } from '@playwright/test';

// 명시한 공개 원문과 실제 로그인 CLI로만 별도 실행하며 일반 회귀에 모델 호출을 섞지 않습니다.
export default defineConfig({
  testDir: '../tests/live',
  tsconfig: './typescript/tsconfig.tools.json',
  outputDir: '../test-results-ui11-live',
  workers: 1,
  timeout: 5_000_000,
  reporter: 'list',
  use: { trace: 'off' },
});
