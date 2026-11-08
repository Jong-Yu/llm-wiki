import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron as electron } from '@playwright/test';

const upstream = new URL(process.argv[2]);
assert.equal(upstream.protocol, 'http:');
assert.equal(upstream.hostname, '127.0.0.1');
const temporary = await mkdtemp('/private/tmp/wiki-ontology-electron-');
const output = resolve('test-results/ontology-query-pilot/electron');
await mkdir(output, { recursive: true });
let application;
try {
  application = await electron.launch({
    args: [
      resolve('out/main/index.js'),
      `--user-data-dir=${join(temporary, 'user')}`,
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      WIKI_CLIENT_ROOT: resolve('..'),
      WIKI_PYTHON: resolve('../.venv/bin/python'),
      WIKI_ANALYSIS_CODEX_CLI: '/usr/bin/false',
      WIKI_QUESTION_CODEX_CLI: '/usr/bin/false',
    },
  });
  // 실제 Electron main의 HTTP 요청만 기록하며 인증정보·응답 본문은 남기지 않는다.
  await application.evaluate(() => {
    const fetch = globalThis.fetch;
    const probe = { calls: [] };
    globalThis.ontologyCacheProbe = probe;
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (
        url.hostname === '127.0.0.1' &&
        /\/ontology\/(search|neighbors)$/.test(url.pathname)
      ) {
        probe.calls.push(
          url.pathname.endsWith('/search') ? 'search' : 'neighbors',
        );
        await new Promise((done) => setTimeout(done, 600));
      }
      return fetch(input, init);
    };
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page
    .getByRole('textbox', { name: '계정 이름', exact: true })
    .fill('지도 탐색 검증');
  await page
    .getByRole('textbox', { name: '서버 주소', exact: true })
    .fill(upstream.href);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByRole('link', { name: '온톨로지', exact: true }).click();
  const panel = page.getByRole('region', { name: '전체 문서에서 개념 찾기' });
  await panel.getByRole('button', { name: /예약 플랫폼/ }).waitFor();
  const count = () =>
    application.evaluate(() => globalThis.ontologyCacheProbe.calls.length);
  const measurements = [];
  for (const text of ['예약 서비스', '결제 서비스', '예약 서비스']) {
    await panel.getByRole('textbox').fill(text);
    const before = await count();
    const start = performance.now();
    await panel.getByRole('button', { name: '검색', exact: true }).click();
    await panel
      .locator('[aria-busy] > ul')
      .getByText(text, { exact: true })
      .first()
      .waitFor();
    measurements.push({
      text,
      visible_ms: Math.round(performance.now() - start),
      requests: (await count()) - before,
    });
  }
  assert.deepEqual(
    measurements.map((row) => row.requests),
    [1, 1, 0],
  );
  assert.equal(
    await panel
      .getByRole('button', { name: '지도에 추가', exact: true })
      .count(),
    10,
  );
  await page.screenshot({ path: resolve(output, 'repeated-search.png') });
  await panel
    .getByRole('button', { name: '지도에 추가', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: '개념 찾기', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'map.png') });
  assert.deepEqual(errors, []);
  const result = {
    actual_electron_main_ipc_renderer: true,
    isolated_user_data: true,
    injected_http_delay_ms: 600,
    measurements,
    browser_errors: errors,
    operations: await application.evaluate(
      () => globalThis.ontologyCacheProbe.calls,
    ),
  };
  await writeFile(
    resolve(output, 'measurements.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
