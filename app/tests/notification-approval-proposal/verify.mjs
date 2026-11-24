import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import axe from 'axe-core';

const here = dirname(fileURLToPath(import.meta.url));
const destination = resolve(
  here,
  '../../../.local/diagnostics/2026-11-24-notification-approval-ui',
);
await mkdir(destination, { recursive: true });
const base = pathToFileURL(
  process.argv[2] ?? resolve(here, 'preview.html'),
).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const requests = [];
const checks = [];
const screenshots = [];
const accessibility = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
function pass(name) {
  checks.push(name);
  console.log('PASS', name);
}
async function settle() {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}
async function open(mode = 'after') {
  const hash =
    mode === 'before'
      ? '/tasks?taskId=000000000000000000000000000000c9'
      : '/notifications';
  await page.goto(`${base}?mode=${mode}#${hash}`);
  await expect(page.locator('.wiki-theme')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '기본 메뉴' }),
  ).toBeVisible();
}
async function scenario(name) {
  await page.evaluate(
    (value) => window.__notificationPreviewScenario(value),
    name,
  );
  await settle();
}
async function navigate(path) {
  await page.evaluate((value) => {
    location.hash = value;
  }, path);
  await settle();
}
async function theme(value) {
  await page.evaluate((next) => {
    localStorage.setItem('llm-wiki.theme-preference', next);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'llm-wiki.theme-preference' }),
    );
  }, value);
  await expect(page.locator('.wiki-theme')).toHaveAttribute(
    'data-wiki-theme',
    value,
  );
  await settle();
}
async function layout(name, widths = [1280, 720, 320]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const value of ['light', 'dark']) {
      await theme(value);
      await page.evaluate(() => {
        for (const element of document.querySelectorAll(
          '[role="main"], [role="main"] *',
        ))
          if (element.scrollTop) element.scrollTop = 0;
      });
      const geometry = await page.evaluate(() => ({
        viewport: document.documentElement.scrollWidth - innerWidth,
        main: [
          ...document.querySelectorAll(
            '[role="main"], [role="main"] > div > div',
          ),
        ].map((element) => element.scrollWidth - element.clientWidth),
      }));
      assert.ok(
        geometry.viewport <= 1,
        `${name} ${width} ${value}: ${JSON.stringify(geometry)}`,
      );
      assert.ok(
        geometry.main.every((overflow) => overflow <= 1),
        `${name} main overflow: ${JSON.stringify(geometry)}`,
      );
      const file = `${name}-${width}-${value}.png`;
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: resolve(destination, file),
        animations: 'disabled',
      });
      screenshots.push(file);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await theme('light');
}
async function audit(name) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    });
    return {
      violations: result.violations,
      incomplete: result.incomplete,
      passes: result.passes.length,
    };
  });
  accessibility.push({ name, ...result });
  assert.deepEqual(result.violations, [], `${name}: accessibility violations`);
}
async function noProductWrites() {
  const counters = await page.evaluate(
    () => window.__documentTaskChecks.snapshot().counters,
  );
  for (const key of [
    'registrations',
    'creates',
    'conversions',
    'analysisStarts',
    'analysisExecutes',
  ])
    assert.equal(counters[key], 0, `Product fixture write: ${key}`);
}

try {
  await open('before');
  await expect(
    page.getByText('문자 확인 필요', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '알림', exact: true }),
  ).toHaveCount(0);
  await layout('before-review');
  await noProductWrites();
  pass('동일 170쪽/30경고 합성 보고로 현재 제품 상세 비교');

  await open();
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.__notificationPreviewScenario),
    )
    .toBe('function');
  await layout('notifications');
  await audit('notifications');
  pass('알림 목록의 1280/720/320px 밝음/다크와 접근성');

  await page.getByRole('button', { name: '모두 읽음', exact: true }).click();
  await page.getByRole('button', { name: '읽지 않음 0', exact: true }).click();
  await expect(
    page.getByText('읽지 않은 알림이 없습니다.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '승인 대기 1', exact: true }).click();
  const reviewButton = page.getByRole('button', {
    name: '검토하기',
    exact: true,
  });
  await expect(reviewButton).toBeVisible();
  await reviewButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-review-count]')).toHaveText(
    '0 / 30쪽 사용 가능',
  );
  await expect(page.locator('[data-approve]')).toBeDisabled();
  await noProductWrites();
  pass('알림 모두 읽음·키보드 열람은 승인하지 않으며 승인 대기는 유지');

  await page
    .getByRole('button', { name: '이 쪽 문자 사용 · 다음 쪽', exact: true })
    .click();
  await expect(page.locator('[data-review-count]')).toHaveText(
    '1 / 30쪽 사용 가능',
  );
  await expect(
    page.getByRole('heading', { name: '6쪽 · 미확인', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '이 쪽 보류', exact: true }).click();
  await expect(page.locator('[data-review-count]')).toHaveText(
    '1 / 30쪽 사용 가능',
  );
  await expect(page.locator('[data-approve]')).toBeDisabled();
  await page.getByRole('button', { name: '보류만 1', exact: true }).click();
  await page.getByRole('button', { name: /^6쪽\s*보류$/ }).click();
  await expect(
    page.getByRole('heading', { name: '6쪽 · 보류', exact: true }),
  ).toBeVisible();
  pass('명시적인 쪽 확인만 집계하며 보류 재진입과 미확인/보류 승인 차단');

  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: '변환 문자', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '6쪽 변환 문자', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '6쪽 원본', exact: true }),
  ).toBeHidden();
  await page.getByRole('button', { name: '원본', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '6쪽 원본', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  pass('좁은 창에서 원본/변환 문자 전환');

  await scenario('unprepared');
  await expect(
    page.getByRole('link', { name: 'AI 연결 필요', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '문자 사용 승인', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: /^승인 저장 중/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: /^승인됨 · 진행 전/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '실행 준비 보기', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '이 PC에서 계속', exact: true }),
  ).toHaveCount(0);
  await noProductWrites();
  pass('실행 미준비 PC는 승인만 저장하고 실행 준비로 안내');

  await scenario('ready');
  await expect(
    page.getByRole('link', { name: 'Codex 연결됨', exact: true }),
  ).toBeVisible();
  await navigate('/notifications');
  await page.getByRole('button', { name: '검토하기', exact: true }).click();
  // 비교 본문 자체의 스크롤이 아닌 페이지 바깥 여백에서 휠을 사용합니다.
  await page.mouse.move(1255, 600);
  await page.mouse.wheel(0, 2200);
  await expect(page.locator('[data-approve]')).toBeInViewport();
  pass('실제 휠 스크롤로 검토 하단 최종 승인에 도달');
  await page.locator('[data-approve]').click();
  for (const label of [
    '승인 저장 중',
    '승인됨 · 진행 전',
    '실행 기기 확보 중',
    '접수 확인 중',
    '이 PC에서 실행 중',
    '처리 완료',
  ])
    await expect(
      page.getByRole('status').filter({ hasText: new RegExp(`^${label}`) }),
    ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole('link', { name: /Wiki 문서 열기/ }),
  ).toBeVisible();
  await page.getByRole('link', { name: '알림으로', exact: true }).click();
  await page.getByRole('button', { name: '읽지 않음 1', exact: true }).click();
  await expect(page.getByText('문서 처리 완료', { exact: true })).toHaveCount(
    1,
  );
  await expect(
    page.getByText('문자 사용 승인 요청', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '모두 읽음', exact: true }).click();
  await page.getByRole('button', { name: '읽지 않음 0', exact: true }).click();
  await expect(
    page.getByText('읽지 않은 알림이 없습니다.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '승인 대기 0', exact: true }).click();
  await expect(
    page.getByText('승인을 기다리는 작업이 없습니다.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '전체', exact: true }).click();
  await expect(
    page.getByText('문자 사용 승인 요청', { exact: true }),
  ).toBeVisible();
  pass('최종 승인→저장→기기 확보→접수→진행→완료와 알림 이력 보존 모의');

  for (const name of [
    'pending',
    'held',
    'ready',
    'unprepared',
    'other-pc',
    'complete',
    'offline',
    'saving',
    'approved',
    'claiming',
    'accepting',
  ]) {
    await scenario(name);
    if (name === 'pending')
      await page.getByRole('button', { name: '검토하기', exact: true }).click();
    await layout(
      name,
      ['pending', 'held', 'ready'].includes(name) ? [1280, 720, 320] : [1280],
    );
    if (['pending', 'ready', 'other-pc', 'complete'].includes(name))
      await audit(name);
    await noProductWrites();
    if (name === 'other-pc')
      await expect(
        page.getByRole('button', { name: '이 PC에서 계속', exact: true }),
      ).toHaveCount(0);
    if (name === 'offline') {
      await expect(page.locator('[data-approve]')).toBeDisabled();
      await expect(
        page.getByRole('button', { name: '이 쪽 보류', exact: true }),
      ).toBeDisabled();
    }
  }
  pass('검토·보류·승인 저장·기기 확보·접수·다른 PC 진행·완료 상태 표시');

  await scenario('held');
  await page.setViewportSize({ width: 1280, height: 1200 });
  await theme('light');
  await page.screenshot({
    path: resolve(destination, 'held-1280x1200-light.png'),
    animations: 'disabled',
  });
  screenshots.push('held-1280x1200-light.png');
  await scenario('ready');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-approve]').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(destination, 'approval-action-1280-light.png'),
    animations: 'disabled',
  });
  screenshots.push('approval-action-1280-light.png');

  await scenario('pending');
  await navigate('/notifications');
  await noProductWrites();
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  pass('실제 제품 fixture 변경/추가 OCR/AI 실행/외부 HTTP 요청/렌더러 오류 0');
} finally {
  await writeFile(
    resolve(destination, 'results.json'),
    JSON.stringify(
      { checks, screenshots, accessibility, requests, errors },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(
  JSON.stringify({
    destination,
    checks: checks.length,
    screenshots: screenshots.length,
  }),
);
