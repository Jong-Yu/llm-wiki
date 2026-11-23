import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const temporary = await mkdtemp('/private/tmp/wiki-document-task-ui-');
let browser;
try {
  const built = await build({
    configFile: false,
    root: here,
    logLevel: 'error',
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
        name: 'DocumentTaskTest',
        formats: ['iife'],
      },
    },
  });
  const output = Array.isArray(built)
    ? built.flatMap((part) => part.output)
    : built.output;
  const script = output
    .filter((part) => part.type === 'chunk')
    .map((part) => part.code)
    .join('\n');
  const css = output
    .filter((part) => part.type === 'asset' && part.fileName.endsWith('.css'))
    .map((part) => part.source)
    .join('\n');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0;background:var(--wiki-color-surface-canvas);color:var(--wiki-color-text-primary)}main{min-width:0}</style></head><body><div id="document-task-test"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const file = resolve(temporary, 'index.html');
  await writeFile(file, html);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${pathToFileURL(file).href}#/tasks`);
  await expect(page.locator('[data-task-id]')).toHaveCount(3);
  await page.getByRole('button', { name: /^조치 필요/ }).click();
  await expect(
    page.getByRole('button', { name: /^조치 필요/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('문서 이름 검색').fill('아키텍처');
  await expect(page.locator('[data-task-id]')).toHaveCount(1);
  const listUrl = page.url();
  await page
    .getByRole('link', { name: '아키텍처 검토 자료', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '다시 변환', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-action-count]')).toHaveText('0');
  await page.getByRole('link', { name: '목록으로 돌아가기' }).click();
  assert.equal(page.url(), listUrl);
  await expect(
    page.getByRole('button', { name: /^조치 필요/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('문서 이름 검색')).toHaveValue('아키텍처');
  console.log(
    'PASS filter/search/detail/return preserve discovery and do not execute',
  );

  await page.goto(
    `${pathToFileURL(file).href}#/tasks?taskId=${'2'.repeat(32)}`,
  );
  await expect(
    page.getByRole('button', { name: '결과 확인', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '다시 변환', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '결과 확인', exact: true }).click();
  await expect(page.locator('[data-action-count]')).toHaveText('1');
  console.log(
    'PASS uncertain task offers query only and runs only on explicit action',
  );

  await page.goto(
    `${pathToFileURL(file).href}#/tasks?taskId=${'3'.repeat(32)}`,
  );
  const taskUrl = page.url();
  await page
    .getByRole('link', { name: '부분 저장 문서', exact: true })
    .last()
    .click();
  assert.match(page.url(), /#\/document\?path=/);
  await page.getByRole('link', { name: '작업으로 돌아가기' }).click();
  assert.equal(page.url(), taskUrl);
  console.log('PASS saved result link carries same task return context');

  for (const width of [1280, 720, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `${pathToFileURL(file).href}#/tasks?taskId=${'a'.repeat(32)}`,
    );
    await expect(
      page.getByRole('button', { name: '다시 변환', exact: true }),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.goto(`${pathToFileURL(file).href}#/tasks`);
    await expect(page.locator('[data-task-id]')).toHaveCount(3);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  await page.evaluate(() => {
    document.documentElement.dataset.wikiTheme = 'dark';
  });
  await page.getByLabel('문서 이름 검색').focus();
  await expect(page.getByLabel('문서 이름 검색')).toBeFocused();
  assert.deepEqual(errors, []);
  console.log(
    'PASS 1280/720/320 layouts, theme, keyboard focus and zero JavaScript errors',
  );
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
