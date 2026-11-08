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
const output = resolve('test-results/ontology-glossary', phase);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  const requests = [];
  const checks = [];
  let mode = 'live';
  let anchorMode = false;
  let release;
  let started;
  await page.route('**/__wiki_test/invoke', async (route) => {
    const payload = route.request().postDataJSON();
    const operation = payload?.args?.[0]?.operation;
    if (anchorMode && payload.channel === 'knowledge:read') {
      const response = await route.fetch();
      const result = await response.json();
      assert(result.ok);
      result.data.effectiveGraph.relations = [
        {
          subject: 'booking',
          predicate: 'defined_in',
          object: {
            kind: 'source_anchor',
            quote: '원문 위치 검증',
            start_line: 3,
            end_line: 3,
            source_revision: result.data.sourceRevision,
          },
          evidence: { quote: '원문 위치 검증', start_line: 3, end_line: 3 },
        },
      ];
      result.data.effectiveGraph.relation_candidates = [];
      return route.fulfill({ json: result });
    }
    if (operation !== 'ontologyGlossary') return route.continue();
    const selectedMode = mode;
    if (selectedMode === 'forbidden' || selectedMode === 'changed') {
      mode = 'live';
      return route.fulfill({
        json: {
          ok: false,
          error: {
            code:
              selectedMode === 'forbidden' ? 'forbidden' : 'catalog_changed',
            status: selectedMode === 'forbidden' ? 403 : 409,
            message: '합성 용어 조회 오류',
          },
        },
      });
    }
    const response = await route.fetch();
    const result = await response.json();
    if (selectedMode === 'context') {
      mode = 'live';
      assert(result.ok);
      result.data.data.entity.context = {
        domain: '예약 업무',
        viewpoints: ['business', 'developer'],
      };
      result.data.data.entity.identifiers = [
        {
          namespace: '예약 플랫폼',
          value: 'BOOKING-01',
          evidence: {
            quote: '예약 플랫폼의 예약 서비스 식별자는 BOOKING-01이다.',
            start_line: 3,
            end_line: 3,
          },
        },
      ];
      result.data.data.source_passage_status = 'limited';
      result.data.data.coverage = {
        complete: false,
        truncated: true,
        skipped: [{ document: '예약-플랫폼.md', code: 'source_context_limit' }],
      };
    }
    if (selectedMode === 'late') {
      mode = 'live';
      assert(result.ok);
      result.data.data.source_passage.quote = '늦게 도착한 이전 선택의 문맥';
      await new Promise((resolve) => {
        release = resolve;
        started?.();
      });
    }
    await route.fulfill({ json: result });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/__wiki_test/invoke')) {
      const body = request.postDataJSON();
      if (body?.args?.[0]?.operation === 'ontologyGlossary')
        requests.push(body.args[0]);
    }
  });
  await page.goto(web);
  await page.waitForFunction(() => Boolean(window.wiki));
  await page.evaluate(() => window.wiki.connection.disconnect());
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
  await panel.getByRole('textbox').fill('예약 서비스');
  await panel.getByRole('button', { name: '검색', exact: true }).click();
  await panel
    .locator('li')
    .filter({ hasText: '예약-플랫폼' })
    .getByRole('button', { name: '지도에 추가', exact: true })
    .click();
  const booking = page.getByTitle('예약 서비스 · 예약-플랫폼.md', {
    exact: true,
  });
  await booking.waitFor();
  assert.equal(requests.length, 0, '선택 전에는 용어 카드를 조회하지 않는다');
  await booking.click();
  const detail = page.getByRole('complementary', {
    name: '개념 정보',
    exact: true,
  });
  await detail
    .getByRole('heading', { name: '예약 서비스', exact: true })
    .waitFor();
  const card = detail.getByRole('region', { name: '용어 설명', exact: true });
  if (phase === 'after') {
    await card.getByRole('link', { name: '원문 열기', exact: true }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input.document, '예약-플랫폼.md');
    assert.match(await card.textContent(), /속성 2\/2개 · 관계 10\/29개/);
    assert.match(await detail.textContent(), /20 \/ 29개/);
    checks.push(
      '선택 뒤에만 현재 문서·개체·판본으로 조회',
      '원문 구절과 카드·지도 각각의 부분 범위 표시',
    );
  }
  await page.screenshot({ path: resolve(output, 'concept-wide.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(output, 'concept-narrow.png') });
  if (phase === 'after') {
    await page.setViewportSize({ width: 320, height: 780 });
    await page.waitForTimeout(200);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: resolve(output, 'concept-320.png') });
    checks.push('390px·320px 가로 넘침 없이 원문 문맥 유지');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const sourceLink = card.getByRole('link', {
      name: '원문 열기',
      exact: true,
    });
    await sourceLink.focus();
    await sourceLink.press('Enter');
    await page.waitForURL(/\/document\?path=/);
    assert.equal(
      new URL(new URL(page.url()).hash.slice(1), web).searchParams.get('path'),
      '예약-플랫폼.md',
    );
    checks.push('키보드로 기존 원문 문서 열기');
    await page.getByRole('link', { name: '온톨로지', exact: true }).click();
    await card.getByRole('link', { name: '원문 열기', exact: true }).waitFor();
    await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
    mode = 'changed';
    await booking.click();
    await card.getByRole('alert').waitFor();
    assert.equal(await card.locator('blockquote').count(), 0);
    await page.screenshot({ path: resolve(output, 'changed-state.png') });
    checks.push('409 변경 판본에서 이전 설명을 표시하지 않음');
    await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
    mode = 'late';
    let waiting = new Promise((resolve) => {
      started = resolve;
    });
    await booking.click();
    await waiting;
    const other = page
      .locator('button[title$=" · 예약-플랫폼.md"]')
      .filter({ hasNotText: '예약 서비스' })
      .first();
    await other.click();
    await card.getByRole('link', { name: '원문 열기', exact: true }).waitFor();
    release();
    await page.waitForTimeout(200);
    assert.equal(
      await page
        .getByText('늦게 도착한 이전 선택의 문맥', { exact: true })
        .count(),
      0,
    );
    checks.push('다른 개념 재선택 뒤 늦은 이전 응답 폐기');
    await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
    mode = 'late';
    waiting = new Promise((resolve) => {
      started = resolve;
    });
    await booking.click();
    await waiting;
    await page.getByRole('link', { name: '문서', exact: true }).click();
    const hiddenCount = requests.length;
    release();
    await page.waitForTimeout(200);
    assert.equal(requests.length, hiddenCount);
    assert.equal(
      await page
        .getByText('늦게 도착한 이전 선택의 문맥', { exact: true })
        .count(),
      0,
    );
    await page.getByRole('link', { name: '온톨로지', exact: true }).click();
    await card.getByRole('link', { name: '원문 열기', exact: true }).waitFor();
    assert(requests.length > hiddenCount);
    assert.equal(
      await page
        .getByText('늦게 도착한 이전 선택의 문맥', { exact: true })
        .count(),
      0,
    );
    checks.push('숨긴 화면의 늦은 응답 폐기·복귀 후 새 조회');
    await page.getByRole('button', { name: '상세 닫기', exact: true }).click();
    mode = 'forbidden';
    await booking.click();
    await detail.waitFor({ state: 'hidden' });
    await panel.waitFor();
    assert.equal(
      await page
        .getByRole('region', { name: '용어 설명', exact: true })
        .count(),
      0,
    );
    await page.screenshot({ path: resolve(output, 'permission-denied.png') });
    checks.push('403 권한 오류에서 카드·기존 개념·관계 상세 모두 숨김');
    mode = 'context';
    await page.goto(
      `${web}/#/ontology?document=${encodeURIComponent('예약-플랫폼.md')}&concept=booking&view=detail`,
    );
    const legacyCard = page.getByRole('region', {
      name: '용어 설명',
      exact: true,
    });
    await legacyCard.getByText('예약 업무', { exact: true }).waitFor();
    await legacyCard.getByText('비즈니스 · 개발', { exact: true }).waitFor();
    await legacyCard.getByText('BOOKING-01', { exact: true }).waitFor();
    await legacyCard.getByText('식별 근거', { exact: true }).click();
    assert.match(
      await legacyCard.textContent(),
      /예약 플랫폼의 예약 서비스 식별자는 BOOKING-01이다/,
    );
    assert.equal(
      await legacyCard
        .getByText('예약 플랫폼의 예약 서비스 식별자는 BOOKING-01이다.', {
          exact: true,
        })
        .count(),
      1,
    );
    await legacyCard.getByRole('status').waitFor();
    await page.screenshot({ path: resolve(output, 'document-context.png') });
    checks.push(
      '문서별 지도에서도 같은 카드·업무 영역·관점·식별 근거·문맥 제한 상태 표시(메타데이터 합성 응답)',
    );
    anchorMode = true;
    await page.reload();
    await legacyCard
      .getByRole('link', { name: '원문 열기', exact: true })
      .waitFor();
    const anchor = page
      .getByRole('region', { name: '온톨로지 연결 지도', exact: true })
      .getByTitle('원문 위치 검증 · 예약-플랫폼.md', { exact: true });
    await anchor.waitFor();
    const beforeAnchor = requests.length;
    await anchor.focus();
    await anchor.press('Enter');
    await page
      .getByRole('heading', { name: '원문 위치 검증', exact: true })
      .waitFor();
    assert.equal(requests.length, beforeAnchor);
    assert.equal(
      await page
        .getByRole('region', { name: '용어 설명', exact: true })
        .count(),
      0,
    );
    checks.push('원문 앵커 표시 노드에는 용어 API 호출 없음(합성 앵커 응답)');
    anchorMode = false;
    mode = 'late';
    waiting = new Promise((resolve) => {
      started = resolve;
    });
    await page.goto(
      `${web}/#/ontology?document=${encodeURIComponent('예약-플랫폼.md')}&concept=booking&view=detail`,
    );
    await waiting;
    await page.evaluate(async () => {
      await window.wiki.connection.disconnect();
      window.dispatchEvent(new Event('wiki-connection-changed'));
    });
    release();
    await page.waitForTimeout(300);
    assert.equal(
      await page
        .getByRole('region', { name: '용어 설명', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByText('늦게 도착한 이전 선택의 문맥', { exact: true })
        .count(),
      0,
    );
    checks.push('연결 종료 후 늦은 응답과 개념 정보 숨김');
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, 'checks.json'),
    JSON.stringify(
      { phase, checks, requests: requests.length, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ phase, output, requests: requests.length }));
} finally {
  await browser.close();
}
