import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(
  '../../test-results/workspace-assignment/',
  import.meta.url,
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [],
  requests = [],
  checks = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (r) => {
  if (/^https?:/.test(r.url())) requests.push(r.url());
});
const refresh = () =>
  page.getByRole('button', {
    name: '워크스페이스 배정 다시 확인',
    exact: true,
  });
const waiting = () =>
  page.getByRole('heading', { name: '워크스페이스 배정 대기', exact: true });
const shot = async (name) =>
  page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, out)),
    fullPage: true,
  });
try {
  await page.goto('file:///private/tmp/wiki-assignment-current.html');
  await expect(
    page.getByRole('textbox', { name: '계정 이름', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.assignmentTest.waiting());
  await expect(waiting()).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.assignmentTest.counts())).mounts,
    0,
  );
  await shot('waiting-1280');
  await refresh().focus();
  await expect(page.getByRole('tooltip')).toHaveText('배정 다시 확인');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(refresh()).toBeEnabled();
  assert.equal(
    (await page.evaluate(() => window.assignmentTest.counts())).refreshes,
    1,
  );
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: '로그아웃', exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('로그아웃');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 736 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await shot('waiting-320');
  await page.getByRole('link', { name: '사용자 가이드' }).click();
  await expect(
    page.getByText('공개 사용자 가이드', { exact: true }),
  ).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.assignmentTest.counts())).mounts,
    0,
  );
  checks.push(
    '기존 로그인 레이아웃·320px·아이콘 focus/tooltip/Escape/Enter/Tab, 대기와 공개 가이드에서 업무 child 0회 mount',
  );

  await page.goto('file:///private/tmp/wiki-assignment-current.html');
  await page.evaluate(() => window.assignmentTest.waiting());
  await expect(waiting()).toBeVisible();
  await page.evaluate(() => window.assignmentTest.mode('error'));
  await refresh().click();
  await expect(
    page.getByText('서버에 연결하지 못했습니다', { exact: true }),
  ).toBeVisible();
  await expect(waiting()).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.assignmentTest.counts())).mounts,
    0,
  );
  await shot('waiting-error-320');
  await page.evaluate(() => window.assignmentTest.mode('assigned'));
  await refresh().click();
  await expect(page.getByText('업무 화면', { exact: true })).toBeVisible();
  assert.equal(
    (await page.evaluate(() => window.assignmentTest.counts())).mounts,
    1,
  );
  checks.push(
    '재확인 네트워크 오류 시 대기 유지·업무 0회, 정상 배정 응답 후에만 업무 mount',
  );

  await page.goto('file:///private/tmp/wiki-assignment-current.html');
  await page.evaluate(() => window.assignmentTest.waiting());
  await expect(waiting()).toBeVisible();
  await page.evaluate(() => window.assignmentTest.mode('delayed'));
  await refresh().click();
  await expect(page.getByText('배정 확인 중…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '계정 이름', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.assignmentTest.release());
  await page.waitForTimeout(50);
  await expect(waiting()).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.assignmentTest.counts())).mounts,
    0,
  );
  await page.goto(
    'file:///private/tmp/wiki-assignment-current.html?initial-race',
  );
  await page.evaluate(() => window.assignmentTest.waiting());
  await expect(waiting()).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '계정 이름', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.assignmentTest.releaseInitial());
  await page.waitForTimeout(50);
  await expect(waiting()).toHaveCount(0);
  checks.push(
    '재확인 중 즉시 로그아웃, 늦은 refresh/getState 성공 응답의 연결 부활 방지',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  await writeFile(
    new URL('browser.json', out),
    JSON.stringify({ passed: true, checks, errors, requests }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser.close();
}
