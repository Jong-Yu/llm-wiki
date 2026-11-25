import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const temporary = await mkdtemp('/private/tmp/wiki-source-preview-ui-');
const built = await build({
  configFile: false,
  root: here,
  base: './',
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
    assetsInlineLimit: 1000000,
    lib: {
      entry: resolve(here, 'renderer.tsx'),
      name: 'OriginalPreviewFixture',
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
await writeFile(
  resolve(temporary, 'index.html'),
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>body{margin:0}${css}</style></head><body><div id="root"></div><script>${scripts.replaceAll('</script', '<\\/script')}</script></body></html>`,
);
let browser;
let checks = 0;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `${pathToFileURL(resolve(temporary, 'index.html')).href}#/documents?workflowId=${'1'.repeat(32)}`,
  );
  const original = page.getByRole('region', { name: '원본', exact: true });
  const editor = page.getByRole('textbox', {
    name: '2페이지 등록할 내용',
    exact: true,
  });
  await expect(original.getByRole('img')).toBeVisible();
  await expect(editor).toBeVisible();
  assert.ok((await original.boundingBox()).x < (await editor.boundingBox()).x);
  await editor.fill('편집 내용 보존');
  await expect(
    original.getByRole('spinbutton', { name: '원본 인쇄 페이지 번호' }),
  ).toHaveValue('1');
  assert.equal(await original.getByRole('button').count(), 3);
  checks += 1;
  const before = await editor.boundingBox();
  await original.getByRole('button', { name: '다음 인쇄 페이지' }).click();
  await expect(original.getByRole('img')).toHaveCount(0);
  await expect(editor).toHaveValue('편집 내용 보존');
  await expect(
    original.getByRole('img', { name: '등록한 원본의 인쇄 페이지 2' }),
  ).toBeVisible();
  assert.deepEqual(await editor.boundingBox(), before);
  checks += 1;
  const viewport = original.getByLabel('원본 인쇄 페이지 2 보기');
  const viewportBox = await viewport.boundingBox();
  await page.evaluate(() => window.__sourcePreviewFixture.setFail(true));
  await original.getByRole('button', { name: '다음 인쇄 페이지' }).click();
  await expect(original.getByRole('alert')).toContainText('LibreOffice');
  assert.deepEqual(
    await original.getByLabel('원본 인쇄 페이지 3 보기').boundingBox(),
    viewportBox,
  );
  assert.deepEqual(await editor.boundingBox(), before);
  await expect(original.getByRole('link', { name: '원본 열기' })).toBeVisible();
  await expect(editor).toHaveValue('편집 내용 보존');
  checks += 1;
  await page.evaluate(() => {
    window.__sourcePreviewFixture.setFail(false);
    window.__sourcePreviewFixture.setFormat('png');
  });
  await page
    .getByRole('button', { name: '상태 다시 확인', exact: true })
    .click();
  await expect(
    original.getByRole('img', { name: '등록한 원본의 이미지 1' }),
  ).toBeVisible();
  await expect(editor).toHaveValue('편집 내용 보존');
  await original.getByRole('link', { name: '원본 열기' }).click();
  await expect(page.getByText('격리 원본 열기')).toBeVisible();
  assert.ok(
    (await page.evaluate(() => window.__sourcePreviewFixture.state()))
      .released > 0,
  );
  checks += 1;
  await page.goto(
    `${pathToFileURL(resolve(temporary, 'index.html')).href}#/scope-probe`,
  );
  const probe = page.getByRole('region', { name: '범위 변경 원본' });
  await expect(probe.getByRole('img')).toBeVisible();
  const originalCounts = await page.evaluate(() =>
    window.__sourcePreviewFixture.state(),
  );
  await page.getByRole('button', { name: '동일 범위 다시 렌더' }).click();
  await expect(probe.getByRole('img')).toBeVisible();
  await page.waitForTimeout(250);
  assert.deepEqual(
    await page.evaluate(() => window.__sourcePreviewFixture.state()),
    originalCounts,
  );
  checks += 1;
  await page.getByRole('button', { name: '실제 범위 변경' }).click();
  await expect(probe.getByRole('img')).toHaveCount(0);
  await expect(probe.getByRole('spinbutton')).toBeDisabled();
  await expect(probe.getByRole('img')).toBeVisible();
  const changedCounts = await page.evaluate(() =>
    window.__sourcePreviewFixture.state(),
  );
  assert.equal(changedCounts.released, originalCounts.released + 1);
  assert.equal(changedCounts.requests, originalCounts.requests + 1);
  checks += 1;
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${checks} original/editor, navigation, stale-image, failure geometry and cleanup UI checks`,
  );
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
