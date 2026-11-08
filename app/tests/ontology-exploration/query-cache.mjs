import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [web, upstream, phase = 'after'] = process.argv.slice(2);
for (const value of [web, upstream]) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
}
assert(['before', 'after'].includes(phase));
const output = resolve('test-results/ontology-query-pilot', phase);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const requests = [];
  let pending = 0;
  let nextFailure = null;
  page.on('pageerror', (error) => errors.push(error.message));
  // 같은 600ms 전송 지연에서 화면 대기와 호출 수를 비교한다. 운영 지연 수치가 아니다.
  await page.route('**/__wiki_test/invoke', async (route) => {
    const request = route.request().postDataJSON();
    const operation = request?.args?.[0]?.operation;
    if (operation === 'ontologySearch' || operation === 'ontologyNeighbors') {
      requests.push({ operation, input: request.args[0].input });
      pending++;
      try {
        await new Promise((done) => setTimeout(done, 600));
        if (nextFailure && operation === 'ontologySearch') {
          const failure = nextFailure;
          nextFailure = null;
          await route.fulfill({ json: { ok: false, error: failure } });
          return;
        }
        const response = await route.fetch();
        await route.fulfill({ response });
      } finally {
        pending--;
      }
    } else await route.continue();
  });
  await page.goto(web);
  // 이 실행기의 전용 웹 서버에 남은 이전 검사 연결만 초기화합니다.
  await page.waitForFunction(() => Boolean(window.wiki));
  await page.evaluate(async () => {
    const result = await window.wiki.connection.disconnect();
    if (!result.ok) throw new Error('isolated_disconnect_failed');
  });
  await page.reload();
  await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
  if (
    !(await page
      .getByRole('textbox', { name: '계정 이름', exact: true })
      .isVisible())
  )
    await page.getByRole('button', { name: '변경', exact: true }).click();
  await page
    .getByRole('textbox', { name: '계정 이름', exact: true })
    .fill('지도 탐색 검증');
  await page
    .getByRole('textbox', { name: '서버 주소', exact: true })
    .fill(upstream);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByRole('link', { name: '온톨로지', exact: true }).click();
  const panel = page.getByRole('region', { name: '전체 문서에서 개념 찾기' });
  const labels = (text) =>
    panel.locator('[aria-busy] > ul').getByText(text, { exact: true });
  await panel.getByRole('button', { name: /예약 플랫폼/ }).waitFor();
  await page.screenshot({ path: resolve(output, 'recent.png') });
  const measurements = [];
  for (const text of ['예약 서비스', '결제 서비스', '예약 서비스']) {
    await panel
      .getByRole('textbox', { name: '전체 문서에서 개념이나 문서 검색' })
      .fill(text);
    const count = requests.length;
    const start = performance.now();
    await panel.getByRole('button', { name: '검색', exact: true }).click();
    await labels(text).first().waitFor();
    const visible = performance.now() - start;
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '[aria-label="전체 문서에서 개념 찾기"] [aria-busy="true"]',
        ),
    );
    while (pending) await new Promise((done) => setTimeout(done, 25));
    measurements.push({
      text,
      visible_ms: Math.round(visible),
      requests: requests.length - count,
    });
  }
  await page.screenshot({ path: resolve(output, 'repeated-search.png') });
  assert.equal(measurements[0].requests, 1);
  assert.equal(measurements[1].requests, 1);
  assert.equal(measurements[2].requests, phase === 'after' ? 0 : 1);
  if (phase === 'after') assert(measurements[2].visible_ms < 400);
  assert.equal(
    await panel
      .getByRole('button', { name: '지도에 추가', exact: true })
      .count(),
    10,
  );
  await panel
    .getByRole('button', { name: '지도에 추가', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: '개념 찾기', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'map.png') });
  assert.equal(
    requests.filter((row) => row.operation === 'ontologyNeighbors').length,
    1,
  );
  const checks = [];
  if (phase === 'after') {
    const waitRequests = async (count) => {
      const deadline = Date.now() + 10_000;
      while (requests.length < count && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 20));
      assert(requests.length >= count);
      while (pending) await new Promise((done) => setTimeout(done, 20));
      await page.waitForFunction(
        () =>
          !document.querySelector(
            '[aria-label="전체 문서에서 개념 찾기"] [aria-busy="true"]',
          ),
      );
    };
    let count = requests.length;
    await page.getByRole('link', { name: '문서', exact: true }).click();
    await page.getByRole('link', { name: '온톨로지', exact: true }).click();
    await waitRequests(count + 1);
    checks.push('화면 복귀 시 TTL 안에서도 최신 검색 재조회');
    await page.getByRole('button', { name: '개념 찾기', exact: true }).click();
    await labels('예약 서비스').first().waitFor();
    count = requests.length;
    nextFailure = {
      code: 'index_unavailable',
      status: 503,
      message: '합성 갱신 실패',
    };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await panel
      .getByRole('status')
      .getByText('검색 결과를 갱신하고 있습니다.')
      .waitFor();
    assert.equal(await labels('예약 서비스').count(), 10);
    await page.getByRole('alert').getByText('합성 갱신 실패').waitFor();
    assert.equal(await labels('예약 서비스').count(), 10);
    await waitRequests(count + 1);
    assert.equal(requests.length, count + 1);
    checks.push(
      '갱신 실패 시 같은 범위의 기존 결과·오류 유지, 자동 재시도 없음',
    );
    await page
      .getByRole('button', { name: '다시 불러오기', exact: true })
      .click();
    await panel
      .getByRole('button', { name: '지도에 추가', exact: true })
      .first()
      .waitFor();
    await panel.getByRole('textbox').fill('');
    await panel.getByRole('button', { name: '검색', exact: true }).click();
    await panel.getByRole('button', { name: /예약 플랫폼/ }).click();
    await panel
      .getByRole('button', { name: '지도에 추가', exact: true })
      .first()
      .waitFor();
    assert.equal(
      await panel
        .getByRole('button', { name: '지도에 추가', exact: true })
        .count(),
      20,
    );
    await panel.getByRole('button', { name: '더 보기', exact: true }).click();
    await panel.getByText('40 / 50개 표시', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '더 보기', exact: true }).click();
    await panel.getByText('50 / 50개 표시', { exact: true }).waitFor();
    assert.equal(
      await panel
        .getByRole('button', { name: '지도에 추가', exact: true })
        .count(),
      50,
    );
    checks.push('실제 cursor로 문서의 20→40→50개 개념 누적');
    count = requests.length;
    await panel.getByRole('button', { name: '검색', exact: true }).click();
    await waitRequests(count + 1);
    checks.push('동일 검색 명시 실행도 최신 재조회');
    nextFailure = { code: 'forbidden', status: 403, message: '합성 권한 회수' };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('alert').getByText('합성 권한 회수').waitFor();
    assert.equal(
      await panel
        .getByRole('button', { name: '지도에 추가', exact: true })
        .count(),
      0,
    );
    await page.screenshot({ path: resolve(output, 'permission-cleared.png') });
    checks.push('403 후 검색·지도 자료 폐기');
  }
  assert.deepEqual(errors, []);
  const result = {
    phase,
    fixture_documents: 10,
    fixture_concepts: 500,
    injected_transport_delay_ms: 600,
    measurements,
    total_search_requests: requests.filter(
      (row) => row.operation === 'ontologySearch',
    ).length,
    neighbor_requests: requests.filter(
      (row) => row.operation === 'ontologyNeighbors',
    ).length,
    browser_errors: errors,
    checks,
  };
  await writeFile(
    resolve(output, 'measurements.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
