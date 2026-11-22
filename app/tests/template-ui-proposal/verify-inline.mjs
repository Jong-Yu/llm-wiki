import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const out = 'test-results/template-ui-proposal-20261114';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1056, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  await page.goto(pathToFileURL(resolve(`${out}/inline-preview.html`)).href);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: '템플릿 선택', exact: true }).click();
  await frame
    .getByRole('button', { name: '새 템플릿 등록', exact: true })
    .click();
  await frame
    .getByRole('button', { name: '예시 양식 불러오기', exact: true })
    .click();
  await frame
    .getByRole('button', { name: '내 템플릿에 저장하고 선택', exact: true })
    .click();
  await expect(
    frame.getByRole('button', { name: '화면 설계서', exact: true }),
  ).toBeVisible();
  await frame.getByRole('button', { name: '작성', exact: true }).click();
  await frame.getByLabel('현재 정책 유지', { exact: false }).check();
  await frame.getByLabel('640px', { exact: true }).check();
  await frame.getByRole('button', { name: '답변 반영', exact: true }).click();
  await expect(
    frame.getByText('내용 1개 확인 필요', { exact: true }),
  ).toBeVisible();
  await frame
    .getByRole('button', { name: '검사 상세 보기', exact: true })
    .click();
  await frame
    .getByRole('button', { name: '수정하고 다시 검사', exact: true })
    .click();
  await expect(
    frame.getByText('내용 자동 검사 통과', { exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByText('원문 대조 검사 불가 1개', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await frame.locator('#template-workflow-preview').evaluate(async (node) => {
    node.ownerDocument.defaultView.scrollTo(0, 0);
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
  });
  await page.screenshot({ path: `${out}/inline-preview.png` });
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    check: 'sandboxed iframe 등록 → 저장 → 작성 → 확인 답변 → 검사·수정',
    errors,
  };
  await writeFile(
    `${out}/inline-verification.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
