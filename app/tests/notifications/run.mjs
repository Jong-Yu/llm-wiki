import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import axe from 'axe-core';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const destination = resolve(
  app,
  '../.local/diagnostics/2026-11-24-notifications-actual-ui',
);
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp('/private/tmp/wiki-notification-ui-');
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
      name: 'NotificationsFixture',
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
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>실제 알림 UI 격리 검증</title><style>body{margin:0}${css}</style></head><body><div id="root"></div><script>${scripts.replaceAll('</script', '<\\/script')}</script></body></html>`,
);
const base = pathToFileURL(resolve(temporary, 'index.html')).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const checks = [];
const errors = [];
const screenshots = [];
page.on('pageerror', (error) => errors.push(error.message));
const detail = `/tasks?workflowId=${'1'.repeat(32)}`;
const list = () => page.getByRole('region', { name: '알림', exact: true });
const work = () =>
  page.getByRole('region', { name: '문자 검토와 처리', exact: true });
const action = (name) => work().getByRole('button', { name, exact: true });
function pass(name) {
  checks.push(name);
  console.log('PASS', name);
}
async function control(method, argument) {
  return page.evaluate(
    ({ method, argument }) => window.__notifications[method](argument),
    { method, argument },
  );
}
async function snapshot() {
  return control('snapshot');
}
async function open(path = '/notifications') {
  await page.goto('about:blank');
  await page.goto(`${base}#${path}`);
  await expect(page.locator('.wiki-theme')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '기본 메뉴' }),
  ).toBeVisible();
}
async function reset(path = detail, prepare) {
  await control('reset');
  if (prepare) await prepare();
  await open(path);
}
async function refreshed() {
  await action('상태 다시 확인').click();
  await expect(work().getByText('작업을 불러오고 있습니다')).toHaveCount(0);
  await expect(action('상태 다시 확인')).toBeEnabled();
}
async function available() {
  await expect(action('이 쪽 문자 사용 · 다음 쪽')).toBeEnabled();
}
async function settle() {
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
        )
        .map((animation) => animation.finished),
    ),
  );
}
async function layout(name) {
  for (const width of [1280, 720, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        localStorage.setItem('llm-wiki.theme-preference', value);
        window.dispatchEvent(
          new StorageEvent('storage', { key: 'llm-wiki.theme-preference' }),
        );
      }, theme);
      await expect(page.locator('.wiki-theme')).toHaveAttribute(
        'data-wiki-theme',
        theme,
      );
      await settle();
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - innerWidth,
        main: [
          ...document.querySelectorAll('[role="main"], [data-workspace-page]'),
        ]
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => e.scrollWidth - e.clientWidth),
      }));
      assert.ok(
        overflow.document <= 1 && overflow.main.every((value) => value <= 1),
        `${name}/${width}/${theme} ${JSON.stringify(overflow)}`,
      );
      const file = `${name}-${width}-${theme}.png`;
      await page.screenshot({ path: resolve(destination, file) });
      screenshots.push(file);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem('llm-wiki.theme-preference', 'light');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'llm-wiki.theme-preference' }),
    );
  });
  await settle();
  pass(`${name}: 320/720/1280px light/dark no horizontal overflow`);
}
async function audit(name) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () =>
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    }),
  );
  assert.deepEqual(
    result.violations,
    [],
    `${name} accessibility: ${JSON.stringify(result.violations)}`,
  );
  pass(`${name}: axe WCAG A/AA`);
}

try {
  await open();
  await expect(list().locator('[data-notification-row]')).toHaveCount(5);
  const geometry = await list()
    .locator('[data-notification-row]')
    .first()
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      title: getComputedStyle(element.querySelector('h2')).fontSize,
      meta: getComputedStyle(element.querySelector('h2 + div')).fontSize,
    }));
  assert.deepEqual(geometry, { height: 64, title: '16px', meta: '12px' });
  await list().getByRole('button', { name: '이전 알림 더 보기' }).click();
  await expect(list().locator('[data-notification-row]')).toHaveCount(9);
  await layout('notification-list');
  await audit('notification-list');
  await list().getByRole('button', { name: '표시된 알림 읽음' }).click();
  await expect(
    list().getByRole('button', { name: '읽지 않음 0', exact: true }),
  ).toBeEnabled();
  await list()
    .getByRole('button', { name: '승인 대기 1', exact: true })
    .click();
  await expect(list().locator('[data-notification-row]')).toHaveCount(1);
  assert.equal((await snapshot()).calls.approve ?? 0, 0);
  assert.equal((await snapshot()).calls.decide ?? 0, 0);
  pass(
    '64px rows / 16px title / 12px metadata, cursor paging, read does not approve',
  );
  await list().getByRole('button', { name: '검토하기' }).focus();
  await page.keyboard.press('Enter');
  await available();
  await expect(action('문자 사용 승인만')).toBeDisabled();
  assert.equal((await snapshot()).calls.decide ?? 0, 0);
  await layout('page-review');
  await audit('page-review');
  await action('이 쪽 보류').click();
  await expect(work().getByRole('heading', { name: '7쪽 대조' })).toBeVisible();
  await action('보류만').click();
  await expect(work().getByRole('heading', { name: '2쪽 대조' })).toBeVisible();
  await expect(action('문자 사용 승인만')).toBeDisabled();
  await available();
  await action('이 쪽 문자 사용 · 다음 쪽').click();
  await expect(action('보류만')).toHaveAttribute('aria-pressed', 'false');
  for (let index = 1; index < 30; index += 1) {
    await available();
    await action('이 쪽 문자 사용 · 다음 쪽').click();
    await expect
      .poll(
        async () =>
          (await snapshot()).detail.workflow.pages.filter(
            (value) => value.state === 'usable',
          ).length,
      )
      .toBe(index + 1);
  }
  await expect(action('30쪽 사용을 승인하고 이 PC에서 계속')).toBeEnabled();
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  pass(
    '170-page report / 30 warning pages, held filter, all server page receipts gate approval',
  );
  await action('30쪽 사용을 승인하고 이 PC에서 계속').click();
  await expect(
    work().getByText('실행 기기: UI 검증 PC', { exact: false }),
  ).toBeVisible();
  let saved = await snapshot();
  assert.equal(saved.calls.approve, 1);
  assert.equal(saved.calls.continue, 1);
  assert.equal(saved.detail.conversion.manifest.units.length, 170);
  await open(detail);
  await expect(
    work().getByText('실행 기기: UI 검증 PC', { exact: false }),
  ).toBeVisible();
  assert.equal((await snapshot()).calls.continue, 1);
  pass(
    'Approval receipt precedes one continue, reload never starts another run',
  );
  await reset(detail, async () => {
    await control('ready', false);
    await control('allUsable');
  });
  await expect(action('문자 사용 승인만')).toBeEnabled();
  await expect(action('30쪽 사용을 승인하고 이 PC에서 계속')).toHaveCount(0);
  await action('문자 사용 승인만').click();
  await expect(action('이 PC에서 계속')).toBeDisabled();
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  await open(detail);
  await expect(action('이 PC에서 계속')).toBeDisabled();
  pass(
    'Unprepared PC can approve only, approved state restores without execution',
  );
  await control('otherPc');
  await refreshed();
  await expect(
    work().getByText('다른 PC에서 처리하고 있습니다.', { exact: false }),
  ).toBeVisible();
  await expect(action('이 PC에서 계속')).toHaveCount(0);
  await layout('other-pc-running');
  pass(
    'Another PC running is not local failure or a new execution opportunity',
  );
  await control('complete');
  await refreshed();
  await expect(
    work().getByRole('link', { name: '보관된 Wiki 보기' }),
  ).toBeVisible();
  await expect(work().getByText('원래 변환 경고 1개')).toBeVisible();
  await layout('complete-history');
  pass(
    'Completion preserves original warnings and approval / execution provenance',
  );
  await reset(detail, async () => {
    await control('allUsable');
    await control('lose', 'approve');
  });
  await expect(action('30쪽 사용을 승인하고 이 PC에서 계속')).toBeEnabled();
  await action('30쪽 사용을 승인하고 이 PC에서 계속').click();
  await expect(work().getByText('저장·접수 결과 확인 필요')).toBeVisible();
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  await refreshed();
  await expect(action('이 PC에서 계속')).toBeEnabled();
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  pass(
    'Lost approval response blocks automatic continue, read recovers receipt',
  );
  await control('lose', 'continue');
  await action('이 PC에서 계속').click();
  await expect(work().getByText('저장·접수 결과 확인 필요')).toBeVisible();
  await refreshed();
  await expect(action('이 PC에서 계속')).toHaveCount(0);
  assert.equal((await snapshot()).calls.continue, 1);
  pass(
    'Lost acceptance response recovers existing running job without duplicate execute',
  );
  await reset(detail, async () => {
    await control('allUsable');
    await control('fail', 'approve');
  });
  await expect(action('문자 사용 승인만')).toBeEnabled();
  await action('문자 사용 승인만').click();
  await expect(work().getByText('저장·접수 결과 확인 필요')).toBeVisible();
  await refreshed();
  await action('문자 사용 승인만').click();
  await expect(action('이 PC에서 계속')).toBeEnabled();
  assert.equal(new Set((await snapshot()).requests.approve).size, 1);
  pass(
    'Lost-before-commit approval retries the same intent only after explicit read and click',
  );
  for (const state of ['claimed', 'failed', 'stopped']) {
    await reset(detail, async () => {
      await control('allUsable');
      await control('resumeState', state);
    });
    const label = state === 'claimed' ? '기존 요청 이어가기' : '이 PC에서 계속';
    await expect(action(label)).toBeEnabled();
    assert.equal((await snapshot()).calls.continue ?? 0, 0);
    await action(label).click();
    await expect(
      work().getByText('UI 검증 PC에서 처리하고 있습니다.', { exact: false }),
    ).toBeVisible();
    assert.equal((await snapshot()).calls.continue, 1);
  }
  pass(
    'Same-PC claim recovery and failed/stopped resume require explicit actions',
  );
  for (const reason of ['source_changed', 'report_changed']) {
    await reset(detail, async () => {
      await control('allUsable');
      await control('obsolete', reason);
    });
    await expect(
      work().getByRole('link', { name: '현재 원본과 새 변환 확인' }),
    ).toBeVisible();
    await expect(
      work().getByText(
        reason === 'source_changed'
          ? '등록 원본이 변경되었습니다.'
          : '새 문자 변환 보고가 있습니다.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(action('이 PC에서 계속')).toHaveCount(0);
    await expect(action('문자 사용 승인만')).toHaveCount(0);
    await expect(action('이 쪽 문자 사용 · 다음 쪽')).toHaveCount(0);
    assert.equal((await snapshot()).calls.continue ?? 0, 0);
  }
  pass(
    'Obsolete source/report is explained and read-only with links to the current source and notifications',
  );
  await reset(detail, async () => {
    await control('fail', 'page');
  });
  await expect(
    work().getByRole('button', { name: '원본 다시 불러오기' }),
  ).toBeVisible();
  await expect(action('이 쪽 문자 사용 · 다음 쪽')).toBeDisabled();
  await work().getByRole('button', { name: '원본 다시 불러오기' }).click();
  await available();
  pass('Original page load failure blocks confirmation and supports retry');
  await control('fail', 'decide');
  await action('이 쪽 문자 사용 · 다음 쪽').click();
  await expect(work().getByText('저장·접수 결과 확인 필요')).toBeVisible();
  await expect(work().getByRole('heading', { name: '2쪽 대조' })).toBeVisible();
  assert.equal((await snapshot()).detail.workflow.pages[0].state, 'pending');
  await refreshed();
  await available();
  await action('이 쪽 문자 사용 · 다음 쪽').click();
  await expect(work().getByRole('heading', { name: '7쪽 대조' })).toBeVisible();
  pass(
    'Failed page write retains position and pending state until confirmed retry',
  );
  await reset(detail, async () => {
    await control('missingText');
    await control('allUsable');
  });
  await expect(
    work().getByText('이 쪽에 연결된 보관 문자를 확인할 수 없습니다.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(action('문자 사용 승인만')).toBeDisabled();
  pass('Missing page text cannot be approved even with stale usable marks');
  await reset('/notifications', async () => {
    await control('fail', 'list');
  });
  await expect(
    list().getByText('알림 수신을 확인하지 못했습니다'),
  ).toBeVisible();
  await expect(list().getByText('보관된 알림이 없습니다.')).toHaveCount(0);
  pass('Offline list shows unknown reception, not zero notifications');
  await reset(detail);
  await available();
  await control('deny');
  await action('상태 다시 확인').click();
  await expect(
    work().getByText('현재 자료에 접근할 수 없습니다.'),
  ).toBeVisible();
  await expect(
    work().getByText('UI 검증 전용 합성 문자입니다.', { exact: false }),
  ).toHaveCount(0);
  pass('403 clears protected source text');
  await reset(detail);
  await available();
  await page.evaluate(() => window.__documentTaskChecks.deny());
  await expect(
    page.getByText('작업 공간 접근이 거부되었습니다.').first(),
  ).toBeVisible();
  await expect(
    page.getByText('UI 검증 전용 합성 문자입니다.', { exact: false }),
  ).toHaveCount(0);
  pass('Account / workspace access change unmounts protected detail');
  await open('/notifications');
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(list().locator('[data-notification-row]').first()).toBeVisible();
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(
      '[data-notification-row] h2,[data-notification-row] h2 + div,[data-notification-row] time,[data-notification-row] button',
    )) {
      const style = getComputedStyle(element);
      element.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
      element.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
    }
  });
  const overlap = await list()
    .locator('[data-notification-row]')
    .evaluateAll((rows) =>
      rows.some((row) => {
        const body = row
          .querySelector('h2')
          .parentElement.getBoundingClientRect();
        const time = row.querySelector('time').getBoundingClientRect();
        const button = row.querySelector('button').getBoundingClientRect();
        return (
          body.bottom > time.top + 1 ||
          time.bottom > button.top + 1 ||
          row.scrollWidth > row.clientWidth + 1
        );
      }),
    );
  assert.equal(overlap, false);
  await page.screenshot({
    path: resolve(destination, 'notification-list-320-text200.png'),
  });
  screenshots.push('notification-list-320-text200.png');
  pass('320px at 200% notification text has separate body, timestamp, action');
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(destination, 'report.json'),
    JSON.stringify({ checks, screenshots, errors }, null, 2),
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      destination,
      screenshots: screenshots.length,
    }),
  );
} catch (cause) {
  console.error('Renderer errors:', errors);
  throw cause;
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
