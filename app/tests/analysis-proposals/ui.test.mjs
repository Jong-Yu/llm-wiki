import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';

await test(
  'browser fixture: comparison layout, CAS draft preservation, guarded apply and responsive controls',
  { timeout: 60000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'ui2-browser-'));
    const server = await createServer({
      configFile: false,
      root: resolve('.'),
      cacheDir: join(temporary, 'vite-cache'),
      plugins: [react()],
      resolve: {
        alias: {
          '@contracts': resolve('src/shared/contracts'),
          '@renderer': resolve('src/renderer'),
        },
      },
      server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
      logLevel: 'error',
    });
    let browser;
    let keepCaptures = false;
    try {
      await server.listen();
      const address = server.httpServer.address();
      assert.ok(address && typeof address !== 'string');
      browser = await chromium.launch({
        headless: true,
        ...(process.env.UI2_CHROMIUM_PATH
          ? { executablePath: process.env.UI2_CHROMIUM_PATH }
          : {}),
      });
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${address.port}/tests/analysis-proposals/ui-fixture.html`,
      );
      await page
        .getByRole('heading', { name: '이전 원문과 고정한 현재 전체 원문' })
        .waitFor();
      await page.getByRole('button', { name: /미발견 · relations/ }).click();
      await page.getByRole('heading', { name: '미발견 관계 처리' }).waitFor();
      await page.screenshot({
        path: join(temporary, 'comparison.png'),
        fullPage: true,
      });
      const apply = page.getByRole('button', {
        name: '검증한 전체 추출안 명시 적용',
      });
      assert.equal(await apply.isDisabled(), true);
      await page
        .getByRole('button', { name: '현재 기준·구조·인용 검증' })
        .click();
      assert.equal(await apply.isDisabled(), true);
      await page
        .getByLabel(
          '전체 후보·미발견·근거를 확인하고 새 그래프 적용을 요청합니다.',
        )
        .check();
      assert.equal(await apply.isEnabled(), true);
      await page
        .getByText('전체 추출안 편집·명시 대응', { exact: true })
        .click();
      const draft =
        '{"schema_version":3,"entities":[],"relations":[],"attributes":[],"relation_candidates":[]}';
      await page.getByLabel('전체 추출 JSON', { exact: true }).fill(draft);
      await page
        .getByRole('button', { name: '전체 추출안을 초안으로 제출' })
        .click();
      await page
        .getByText('격리 fixture의 CAS 충돌: 이전 초안을 보존합니다.')
        .waitFor();
      assert.equal(
        await page.getByLabel('전체 추출 JSON', { exact: true }).inputValue(),
        draft,
      );
      assert.equal(await apply.isDisabled(), true);
      await page.getByRole('button', { name: '현재 추출안 다시 읽기' }).click();
      await page
        .getByRole('heading', { name: '새로 관측한 서버 추출안' })
        .waitFor();
      assert.equal(
        await page.getByLabel('전체 추출 JSON', { exact: true }).inputValue(),
        draft,
      );
      await page.screenshot({
        path: join(temporary, 'wide.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: join(temporary, 'compact.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 700, height: 720 });
      await page
        .getByRole('button', { name: '판단·적용', exact: true })
        .click();
      await page
        .getByRole('heading', { name: '미발견 관계 처리' })
        .waitFor({ state: 'visible' });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(
        `http://127.0.0.1:${address.port}/tests/analysis-proposals/ui-fixture.html?execution=1`,
      );
      const start = page.getByRole('button', {
        name: '명시 AI 재추출 실행',
        exact: true,
      });
      await start.waitFor();
      await start.click();
      await page
        .getByRole('button', { name: '실행 중단 요청', exact: true })
        .click();
      await page
        .getByText('개인 실행 종료 · 중단됨', { exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: '기록 보존 후 새 실행 준비', exact: true })
        .click();
      await start.click();
      await page
        .getByText('개인 실행 종료 · 후보 저장 기록 확인', { exact: true })
        .waitFor();
      await page
        .getByRole('button', {
          name: '현재 후보 조회·이전 결과와 비교',
          exact: true,
        })
        .click();
      await page
        .getByRole('heading', { name: '이전 후보와 새 후보', exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', {
            name: '검증한 전체 추출안 명시 적용',
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await page.screenshot({
        path: join(temporary, 'execution-comparison.png'),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      // 캡처는 필요할 때만 보존하며 기본 실행은 자기 임시 경로를 정리합니다.
      keepCaptures = process.env.UI2_KEEP_CAPTURES === '1';
      if (keepCaptures) console.log(`UI2_CAPTURES=${temporary}`);
    } finally {
      await browser?.close();
      await server.close();
      if (!keepCaptures) await rm(temporary, { recursive: true, force: true });
    }
  },
);
