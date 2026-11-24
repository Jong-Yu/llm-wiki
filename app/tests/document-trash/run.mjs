import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const root = await mkdtemp('/private/tmp/wiki-web-verify-trash-');
const evidence = process.env.WIKI_TRASH_CAPTURE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const server = spawn(
  join(project, '.venv/bin/python'),
  ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(root, 'fixture')],
  {
    cwd: project,
    env: { ...process.env, PYTHONPATH: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let error = '';
server.stderr.on('data', (chunk) => {
  error = (error + chunk).slice(-4000);
});
let vite, browser;
try {
  const url = await new Promise((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Isolated server startup timeout: ' + error)),
      15000,
    );
    server.stdout.on('data', (chunk) => {
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timeout);
        accept(match[1]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(error || 'Isolated server exited'));
    });
  });
  const alias = {
    '@main': join(appRoot, 'src/main'),
    '@contracts': join(appRoot, 'src/shared/contracts'),
    '@renderer': join(appRoot, 'src/renderer'),
  };
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: { alias },
    ssr: { noExternal: true },
    build: {
      ssr: join(appRoot, 'tests/document-trash/fixture.ts'),
      outDir: join(root, 'compiled'),
      rolldownOptions: { output: { entryFileNames: 'fixture.mjs' } },
    },
  });
  const { createFixture } = await import(
    pathToFileURL(join(root, 'compiled/fixture.mjs')).href
  );
  const fixture = await createFixture(root, project, url);
  vite = await createServer({
    configFile: false,
    root: join(appRoot, 'tests/document-trash'),
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias },
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address !== 'string');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.exposeFunction('executeFixture', fixture.execute);
  await page.addInitScript(
    (value) => {
      window.fixture = value;
    },
    {
      scope: fixture.scope,
      alternateScope: fixture.alternateScope,
      items: fixture.items,
    },
  );
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('button', { name: 'Wiki 삭제', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  for (const width of [1280, 320])
    for (const theme of ['light', 'dark']) {
      const visual = await browser.newPage({
        viewport: { width, height: 900 },
      });
      await visual.exposeFunction('executeFixture', fixture.execute);
      await visual.addInitScript(
        (value) => {
          window.fixture = value;
        },
        {
          scope: fixture.scope,
          alternateScope: fixture.alternateScope,
          items: fixture.items,
        },
      );
      await visual.goto(`http://127.0.0.1:${address.port}`);
      await visual.evaluate((theme) => {
        document.body.dataset.wikiTheme = theme;
      }, theme);
      await visual
        .getByRole('button', { name: 'Wiki 삭제', exact: true })
        .click();
      await expect(visual.getByRole('dialog')).toBeVisible();
      const bounds = await visual.getByRole('dialog').boundingBox();
      assert(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        `dialog fits ${width}/${theme}`,
      );
      assert(
        await visual.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `no horizontal overflow ${width}/${theme}`,
      );
      if (evidence)
        await visual.screenshot({
          animations: 'disabled',
          path: join(evidence, `confirm-${width}-${theme}.png`),
        });
      await visual.close();
    }
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Wiki 삭제', exact: true }),
  ).toBeFocused();
  assert.equal(await page.evaluate(() => window.writes), 0);
  console.log('PASS cancel and confirmation layout at 1280/320 light/dark');
  await page.getByRole('button', { name: 'Wiki 삭제', exact: true }).click();
  await page
    .getByRole('button', { name: '휴지통으로 이동', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal(
    (await fixture.list()).filter((item) => item.kind === 'wiki').length,
    0,
  );
  await page.getByRole('button', { name: '휴지통 열기', exact: true }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Wiki 문서' })
    .getByRole('button', { name: /복원$/ })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '복원', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal(
    (await fixture.list()).filter((item) => item.kind === 'wiki').length,
    1,
  );
  console.log(
    'PASS real WorkspaceApiService wiki trash, catalogue exclusion and restore',
  );
  await page.getByRole('button', { name: '원본 삭제', exact: true }).click();
  await page
    .getByRole('button', { name: '휴지통으로 이동', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal(
    (await fixture.list()).filter((item) => item.kind === 'source').length,
    0,
  );
  await page
    .getByRole('button', { name: '등록 원본 검증 자료 복원', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '복원', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal((await fixture.list()).length, 2);
  console.log('PASS real source trash and restore');
  await page.evaluate(() => {
    window.mode = 'conflict';
  });
  await page.getByRole('button', { name: 'Wiki 삭제', exact: true }).click();
  await page
    .getByRole('button', { name: '휴지통으로 이동', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: '다른 변경이 있습니다' }),
  ).toBeVisible();
  assert.equal((await fixture.list()).length, 2);
  console.log('PASS actual server CAS rejection keeps document');
  await page.evaluate(() => {
    window.mode = 'unknown';
  });
  await page.getByRole('button', { name: 'Wiki 삭제', exact: true }).click();
  const beforeUnknown = await page.evaluate(() => window.writes);
  await page
    .getByRole('button', { name: '휴지통으로 이동', exact: true })
    .click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '처리 결과를 확인하지 못했습니다' }),
  ).toBeVisible();
  assert.equal(await page.evaluate(() => window.writes), beforeUnknown + 1);
  await page.evaluate(() => {
    window.mode = 'normal';
  });
  await page.getByRole('button', { name: '새로 고침', exact: true }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Wiki 문서' })
    .getByRole('button', { name: /복원$/ })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '복원', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  console.log(
    'PASS response loss stays unconfirmed without automatic write replay',
  );
  await page.evaluate(() => {
    window.mode = 'delayed';
  });
  await page.getByRole('button', { name: 'Wiki 삭제', exact: true }).click();
  await page
    .getByRole('button', { name: '휴지통으로 이동', exact: true })
    .click();
  await page.waitForFunction(() => typeof window.releaseDelayed === 'function');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach((button) => {
      if (button.textContent === '범위 변경') button.click();
    });
  });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.evaluate(() => {
    window.mode = 'normal';
    window.releaseDelayed?.();
  });
  await page.waitForFunction(() => window.delayedSettled);
  await expect(
    page.getByRole('button', { name: 'Wiki 삭제', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Wiki 삭제', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '휴지통으로 이동했습니다' }),
  ).toHaveCount(0);
  assert.deepEqual(failures, []);
  console.log(
    'PASS scope change drops previous confirmation, feedback and busy state',
  );
} finally {
  await browser?.close();
  await vite?.close();
  server.kill('SIGTERM');
  await new Promise((done) =>
    server.exitCode !== null ? done() : server.once('exit', done),
  );
  await rm(root, { recursive: true, force: true });
}
