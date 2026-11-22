import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const out = 'test-results/template-ui-options-20261114';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1056, height: 900 },
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const url = pathToFileURL(resolve(`${out}/inline-preview.html`)).href;
  await page.goto(url);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-variant="채팅에서 선택"]')).toBeVisible();
  await frame
    .getByRole('textbox', { name: '질문', exact: true })
    .fill('시안 비교 중인 질문');
  await frame.getByRole('button', { name: '다음 시안', exact: true }).click();
  const gallery = frame.locator('[data-variant="템플릿 보관함"]');
  await expect(
    gallery.getByRole('heading', { name: '템플릿 보관함', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${out}/gallery.png` });
  await gallery
    .getByRole('button', { name: '이 템플릿으로 작성', exact: true })
    .click();
  await gallery
    .getByRole('textbox', { name: '이번 요청의 작성 규칙', exact: true })
    .fill('모바일 예외 상태도 표시한다.');
  await frame.getByRole('button', { name: '이전 시안', exact: true }).click();
  await expect(
    frame.getByRole('textbox', { name: '질문', exact: true }),
  ).toHaveValue('시안 비교 중인 질문');
  await frame.getByRole('button', { name: '다음 시안', exact: true }).click();
  await expect(
    gallery.getByRole('textbox', {
      name: '이번 요청의 작성 규칙',
      exact: true,
    }),
  ).toHaveValue('모바일 예외 상태도 표시한다.');
  checks.push('캐러셀 왕복에서 채팅 질문·보관함 입력 보존');
  await gallery
    .getByRole('button', { name: '작성 전 확인', exact: true })
    .click();
  await gallery.locator('input[name="gallery-policy"]').nth(2).check();
  await gallery.locator('input[name="gallery-width"]').first().check();
  await gallery
    .getByRole('button', { name: '답변으로 예시 확인', exact: true })
    .click();
  await expect(
    gallery.getByRole('heading', { name: '두 가지만 확인할게요', exact: true }),
  ).toBeVisible();
  await gallery
    .getByLabel('검토자 예외를 변경안으로 작성', { exact: true })
    .check();
  await gallery
    .getByRole('button', { name: '답변으로 예시 확인', exact: true })
    .click();
  await expect(
    gallery.getByText('원문 검사 불가 1개', { exact: true }),
  ).toBeVisible();
  await gallery
    .getByRole('button', { name: '너비 수정 후 다시 검사', exact: true })
    .click();
  await expect(
    gallery.getByText('내용 자동 검사 통과', { exact: true }),
  ).toBeVisible();
  await expect(
    gallery.getByText('원문 검사 불가 1개', { exact: true }),
  ).toBeVisible();
  checks.push('보관함 요청 → 미정 대기 → 확정 → 수정 후 검사 불가 유지');

  await page.goto(url);
  await frame.getByRole('button', { name: '다음 시안', exact: true }).click();
  await frame.getByRole('button', { name: '다음 시안', exact: true }).click();
  const guided = frame.locator('[data-variant="단계별 작성"]');
  await expect(
    guided.getByRole('heading', { name: '템플릿으로 문서 작성', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${out}/guided.png` });
  for (const width of [768, 352]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await frame
      .locator('body')
      .evaluate((body) => ({
        viewport: body.ownerDocument.documentElement.clientWidth,
        width: body.ownerDocument.documentElement.scrollWidth,
      }));
    assert.ok(
      dimensions.width <= dimensions.viewport + 1,
      JSON.stringify(dimensions),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${out}/guided-${dimensions.viewport}.png` });
    await frame.getByRole('button', { name: '이전 시안', exact: true }).click();
    const galleryDimensions = await frame
      .locator('body')
      .evaluate((body) => ({
        viewport: body.ownerDocument.documentElement.clientWidth,
        width: body.ownerDocument.documentElement.scrollWidth,
      }));
    assert.ok(
      galleryDimensions.width <= galleryDimensions.viewport + 1,
      JSON.stringify(galleryDimensions),
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `${out}/gallery-${galleryDimensions.viewport}.png`,
    });
    await frame.getByRole('button', { name: '다음 시안', exact: true }).click();
  }
  checks.push('736·320px iframe에서 보관함·단계별 작성 가로 넘침 없음');
  await page.setViewportSize({ width: 1056, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${out}/guided-dark.png` });
  const duplicates = await frame.locator('body').evaluate((body) => {
    const ids = [...body.querySelectorAll('[id]')].map((node) => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  assert.deepEqual(duplicates, []);
  assert.deepEqual(errors, []);
  checks.push('다크 화면 캡처·고정 ID 중복 없음·런타임 오류 없음');
  const result = { passed: true, checks, errors, duplicates };
  await writeFile(`${out}/verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
