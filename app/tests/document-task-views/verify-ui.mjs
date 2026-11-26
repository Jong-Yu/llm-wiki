import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const temporary = await mkdtemp('/private/tmp/wiki-document-task-ui-');
let browser;
let historyCapture;
if (process.env.WIKI_TASK_HISTORY_CAPTURE_DIR) {
  await mkdir(process.env.WIKI_TASK_HISTORY_CAPTURE_DIR, { recursive: true });
  historyCapture = await mkdtemp(
    resolve(process.env.WIKI_TASK_HISTORY_CAPTURE_DIR, 'after-'),
  );
  console.log(`History captures: ${historyCapture}`);
}
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
  const html = `<!doctype html><html lang="ko" data-wiki-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0;background:var(--wiki-color-surface-canvas);color:var(--wiki-color-text-primary)}main{min-width:0}</style></head><body><div id="document-task-test"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  const file = resolve(temporary, 'index.html');
  await writeFile(file, html);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${pathToFileURL(file).href}#/documents`);
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
  await expect(
    page.getByRole('link', { name: '문서 목록', exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  assert.equal(page.url(), listUrl);
  await expect(
    page.getByRole('button', { name: /^조치 필요/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('문서 이름 검색')).toHaveValue('아키텍처');
  console.log(
    'PASS filter/search/detail/return preserve discovery and do not execute',
  );

  await page.goto(
    `${pathToFileURL(file).href}#/documents?taskId=${'2'.repeat(32)}`,
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
    `${pathToFileURL(file).href}#/documents?taskId=${'3'.repeat(32)}`,
  );
  const taskUrl = page.url();
  await page
    .getByRole('link', { name: '저장된 문서 열기', exact: true })
    .last()
    .click();
  assert.match(page.url(), /#\/document\?path=/);
  await page.getByRole('link', { name: '작업으로 돌아가기' }).click();
  assert.equal(page.url(), taskUrl);
  console.log('PASS saved result link carries same task return context');

  const progressActionCount = Number(
    await page.locator('[data-action-count]').innerText(),
  );
  const bounds = [];
  for (const id of ['4', '5', '6', '7']) {
    await page.goto(
      `${pathToFileURL(file).href}#/documents?taskId=${id.repeat(32)}`,
    );
    const focus = page.locator('[data-progress-focus]');
    await expect(focus).toBeVisible();
    bounds.push(await focus.boundingBox());
    await expect(page.locator('[data-action-count]')).toHaveText(
      String(progressActionCount),
    );
    await expect(page.locator('[data-stage]')).toHaveCount(3);
    await expect(
      page.locator('details, code, a[href*="ontology"]'),
    ).toHaveCount(0);
    if (id === '4') {
      await expect(
        page.getByRole('progressbar', { name: '문자 변환 처리량' }),
      ).toHaveAttribute('value', '73');
      await expect(page.getByRole('progressbar')).toHaveAttribute('max', '170');
      await expect(focus).toContainText('42%');
      await expect(focus).toContainText('남은 97 페이지');
    } else {
      await expect(page.getByRole('progressbar')).toHaveCount(0);
      assert.doesNotMatch(await focus.innerText(), /\d+%/);
    }
    if (id === '6' && process.env.WIKI_TASK_VIEW_SCREENSHOT) {
      await page.screenshot({
        path: process.env.WIKI_TASK_VIEW_SCREENSHOT,
        animations: 'disabled',
      });
    }
  }
  assert.ok(bounds.every(Boolean));
  assert.ok(
    Math.max(...bounds.map((box) => box.height)) -
      Math.min(...bounds.map((box) => box.height)) <=
      1,
  );
  assert.ok(
    Math.max(...bounds.map((box) => box.y)) -
      Math.min(...bounds.map((box) => box.y)) <=
      1,
  );
  await page.goto(`${pathToFileURL(file).href}#/documents?loading=1`);
  const loadingBounds = await page
    .locator('[data-progress-focus]')
    .boundingBox();
  assert.ok(loadingBounds);
  assert.ok(Math.abs(loadingBounds.height - bounds[0].height) <= 1);
  assert.ok(Math.abs(loadingBounds.y - bounds[0].y) <= 1);
  await page.goto(
    `${pathToFileURL(file).href}#/documents?taskId=${'6'.repeat(32)}&error=1`,
  );
  const errorBounds = await page.locator('[data-progress-focus]').boundingBox();
  assert.ok(errorBounds);
  assert.equal(errorBounds.height, bounds[2].height);
  assert.equal(errorBounds.y, bounds[2].y);
  await expect(page.getByRole('alert')).toHaveText(
    '서버 응답을 확인하지 못했습니다.',
  );
  await page.goto(`${pathToFileURL(file).href}#/documents?loading=1&error=1`);
  await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(progressActionCount + 1),
  );
  console.log(
    'PASS stable loading/conversion/Wiki/ontology/completion focus geometry and real conversion progress only',
  );

  await page.goto(
    `${pathToFileURL(file).href}#/documents?jobId=${'a'.repeat(32)}`,
  );
  const serverUrl = page.url();
  await expect(page.locator('[data-stage="convert"]')).toHaveAttribute(
    'data-state',
    'unavailable',
  );
  await expect(
    page.getByRole('heading', { name: '온톨로지 구성 중' }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: '저장된 문서 열기', exact: true })
    .click();
  await page.getByRole('link', { name: '작업으로 돌아가기' }).click();
  assert.equal(page.url(), serverUrl);
  await page.getByRole('button', { name: '실행 기록', exact: true }).click();
  await page.getByRole('link', { name: '작업으로 돌아가기' }).click();
  assert.equal(page.url(), serverUrl);
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(progressActionCount + 1),
  );
  await page.getByRole('button', { name: '새로고침', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(progressActionCount + 2),
  );
  console.log(
    'PASS server-only result/history return and keyboard refresh never start processing',
  );

  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 720, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `${pathToFileURL(file).href}#/documents?taskId=${'a'.repeat(32)}`,
      );
      await expect(
        page.getByRole('button', { name: '다시 변환', exact: true }),
      ).toBeVisible();
      await page.evaluate((value) => {
        document.documentElement.dataset.wikiTheme = value;
      }, theme);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.goto(
        `${pathToFileURL(file).href}#/documents?taskId=${'8'.repeat(32)}`,
      );
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        '아키텍처 검토 자료',
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.goto(`${pathToFileURL(file).href}#/documents`);
      await expect(page.locator('[data-task-id]')).toHaveCount(3);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    }
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

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.wikiTheme = 'light';
  });
  await page.clock.install({ time: new Date('2026-11-25T03:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-25T03:01:00Z'));
  await page.evaluate(() => window.__remoteProgressChecks.reset());
  await page.goto(
    `${pathToFileURL(file).href}#/documents?remoteCheck=inactive`,
  );
  const resume = page.getByRole('button', {
    name: '중단된 단계 다시 시작',
    exact: true,
  });
  await expect(resume).toBeEnabled();
  let remoteCounts = await page.evaluate(() =>
    window.__remoteProgressChecks.counts(),
  );
  assert.equal(remoteCounts.inspect, 1);
  assert.equal(remoteCounts.execute, 0);
  assert.deepEqual(remoteCounts.inspections[0], {
    connectionId: 'fixture-only',
    jobId: 'a'.repeat(32),
  });
  await page.evaluate(() => window.__remoteProgressChecks.defer());
  await resume.click();
  await expect(resume).toBeDisabled();
  remoteCounts = await page.evaluate(() =>
    window.__remoteProgressChecks.counts(),
  );
  assert.equal(remoteCounts.inspect, 2);
  assert.equal(remoteCounts.pending, true);
  assert.equal(remoteCounts.execute, 0);
  await page
    .getByRole('button', { name: '화면 비활성화', exact: true })
    .click();
  await expect(page.locator('[data-remote-active]')).toHaveAttribute(
    'data-remote-active',
    'false',
  );
  await page
    .getByRole('button', { name: '검사 응답 도착', exact: true })
    .click();
  await expect(resume).toBeEnabled();
  await page.clock.runFor(12000);
  remoteCounts = await page.evaluate(() =>
    window.__remoteProgressChecks.counts(),
  );
  assert.equal(remoteCounts.inspect, 2);
  assert.equal(remoteCounts.pending, false);
  assert.equal(remoteCounts.execute, 0);
  console.log(
    'PASS real RemoteDocumentProgress: initial inspect never executes; late resume inspection after inactivity cannot execute',
  );

  await page.goto(`${pathToFileURL(file).href}#/documents`);
  await expect(page.locator('[data-task-id]')).toHaveCount(3);
  await page.evaluate(() => window.__remoteProgressChecks.reset());
  await page.goto(`${pathToFileURL(file).href}#/documents?remoteCheck=double`);
  await expect(resume).toBeEnabled();
  assert.equal(
    (await page.evaluate(() => window.__remoteProgressChecks.counts())).inspect,
    1,
  );
  await page.evaluate(() => window.__remoteProgressChecks.defer());
  // 같은 JS 턴의 두 실제 클릭으로 React 상태 반영 전에도 중복 요청을 막는지 확인합니다.
  await resume.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(resume).toBeDisabled();
  remoteCounts = await page.evaluate(() =>
    window.__remoteProgressChecks.counts(),
  );
  assert.equal(
    remoteCounts.inspect,
    2,
    'one initial read + exactly one pre-execution inspection',
  );
  assert.equal(remoteCounts.pending, true);
  assert.equal(remoteCounts.execute, 0);
  await page
    .getByRole('button', { name: '검사 응답 도착', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '등록 완료', exact: true }),
  ).toBeVisible();
  await expect(resume).toHaveCount(0);
  remoteCounts = await page.evaluate(() =>
    window.__remoteProgressChecks.counts(),
  );
  assert.equal(remoteCounts.execute, 1);
  assert.equal(
    remoteCounts.inspect,
    3,
    'the third inspection is the explicit post-execution refresh',
  );
  assert.deepEqual(remoteCounts.executions, [
    {
      connectionId: 'fixture-only',
      jobId: 'a'.repeat(32),
      expectedJobRevision: 'e'.repeat(64),
      mode: 'resume',
    },
  ]);
  await page.clock.runFor(12000);
  remoteCounts = await page.evaluate(() =>
    window.__remoteProgressChecks.counts(),
  );
  assert.ok(remoteCounts.inspect > 3, 'active polling reads are exercised');
  assert.equal(
    remoteCounts.execute,
    1,
    'polling and completion never execute again',
  );
  assert.equal(remoteCounts.pending, false);
  assert.deepEqual(errors, []);
  console.log(
    'PASS real RemoteDocumentProgress: synchronous double click inspects once and executes once; completion/polling never rerun',
  );

  await page.clock.resume();
  const historyUrl = `${pathToFileURL(file).href}#/documents?taskId=${'a'.repeat(32)}&view=history`;
  await page.goto(historyUrl);
  await expect(page.locator('[data-task-history]')).toBeVisible();
  await expect(page.getByText('등록 진행으로 돌아가기')).toHaveCount(0);
  await expect(page.getByRole('table')).toContainText('실패');
  await expect(page.getByRole('table')).not.toContainText('· failed');
  const beforeHistoryActions = Number(
    await page.locator('[data-action-count]').innerText(),
  );
  await page
    .getByRole('button', { name: '실행 기록 새로고침', exact: true })
    .focus();
  await expect(page.getByRole('tooltip')).toHaveText('실행 기록 새로고침');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(beforeHistoryActions + 1),
  );
  await page.getByRole('button', { name: '다시 변환', exact: true }).click();
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(beforeHistoryActions + 2),
  );
  await page.getByRole('button', { name: '원본 보기', exact: true }).click();
  await expect(page).toHaveURL(/#\/source\?/);
  await page
    .getByRole('link', { name: '작업으로 돌아가기', exact: true })
    .click();
  assert.equal(page.url(), historyUrl);
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(beforeHistoryActions + 2),
  );
  await page
    .getByRole('button', { name: '등록 진행 열기', exact: true })
    .click();
  await expect(page.locator('[data-task-detail]')).toBeVisible();
  await expect(page.locator('[data-action-count]')).toHaveText(
    String(beforeHistoryActions + 2),
  );
  await page.goto(`${historyUrl}&busy=1&error=1`);
  await expect(
    page.getByRole('button', { name: '다시 변환', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '실행 기록 새로고침', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('마지막으로 확인한 내용');
  await expect(page.locator('[data-attempt-row]')).toHaveCount(1);
  await page.goto(
    `${pathToFileURL(file).href}#/documents?taskId=${'2'.repeat(32)}&view=history`,
  );
  await expect(
    page.getByRole('button', { name: '결과 확인', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '다시 변환', exact: true }),
  ).toHaveCount(0);
  await page.goto(
    `${pathToFileURL(file).href}#/documents?taskId=${'0'.repeat(32)}&view=history`,
  );
  await expect(
    page.getByText('이 기기에 보관된 문자 변환 이력이 없습니다.'),
  ).toBeVisible();
  await expect(page.locator('[data-attempt-row]')).toHaveCount(0);
  const reviewHistoryUrl = `${pathToFileURL(file).href}#/documents?taskId=${'b'.repeat(32)}&view=history`;
  await page.goto(reviewHistoryUrl);
  const beforeReview = await page.locator('[data-action-count]').innerText();
  await page
    .getByRole('link', { name: '등록할 내용 확인', exact: true })
    .click();
  await expect(page).toHaveURL(/workflowId=c{32}&returnTask=b{32}/);
  await page
    .getByRole('link', { name: '작업으로 돌아가기', exact: true })
    .click();
  assert.equal(page.url(), reviewHistoryUrl);
  await expect(page.locator('[data-action-count]')).toHaveText(beforeReview);
  console.log(
    'PASS actual execution history: localized states, explicit actions, query-only uncertainty, busy/error preservation, empty history, keyboard tooltip and navigation',
  );

  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 720, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => {
        document.documentElement.dataset.wikiTheme = value;
      }, theme);
      for (const id of ['a', '8', '9']) {
        await page.goto(
          `${pathToFileURL(file).href}#/documents?taskId=${id.repeat(32)}&view=history`,
        );
        await expect(page.locator('[data-task-history]')).toBeVisible();
        await expect(page.locator('[data-attempt-row]')).toHaveCount(
          id === '9' ? 2 : 1,
        );
        if (id === '9') {
          await expect(page.getByRole('table')).toContainText('메모리');
          await expect(page.getByRole('table')).toContainText('완료');
        }
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
          `history overflow ${id} ${theme} ${width}`,
        );
        assert.equal(
          await page
            .locator('[data-task-history]')
            .evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
          `history content overflow ${id} ${theme} ${width}`,
        );
        if (width === 320) {
          const mark = await page
            .locator('ol[aria-label="문서 등록 단계"] li > span')
            .first()
            .boundingBox();
          assert.ok(
            mark && Math.abs(mark.width - mark.height) <= 1,
            'stage marker remains circular',
          );
          const rowTitle = await page
            .locator('[data-attempt-row] th')
            .first()
            .boundingBox();
          const bodyCell = await page
            .locator('[data-attempt-row] td[data-label="처리 내용"] > div')
            .first()
            .boundingBox();
          assert.ok(
            rowTitle && rowTitle.width > 200,
            'mobile row heading uses the record width',
          );
          assert.ok(
            bodyCell && bodyCell.width > 150,
            'all message paragraphs use the content column',
          );
        }
        if (
          historyCapture &&
          ((id === 'a' && theme === 'light' && width !== 720) ||
            (id === '9' && width === 1280) ||
            (id === '8' && theme === 'dark' && width === 320))
        ) {
          await page.mouse.move(0, 890);
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement)
              document.activeElement.blur();
          });
          await expect(page.getByRole('tooltip')).toHaveCount(0);
          await page.screenshot({
            path: resolve(
              historyCapture,
              `history-${id}-${theme}-${width}.png`,
            ),
            fullPage: true,
            animations: 'disabled',
          });
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS history real component light/dark at 1280/720/320: long title/message and multiple attempts remain readable without page or section overflow',
  );
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
