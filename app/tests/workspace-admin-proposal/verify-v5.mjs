import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { compile } from 'sass-embedded';
import { chromium, expect } from '@playwright/test';

const out = new URL('./verification/admin-console-v5/', import.meta.url);
await mkdir(out, { recursive: true });
const fragmentPath =
  process.argv[2] ??
  '/Users/jong-yu/.codex/visualizations/2026/11/16/01a1e40f-f625-7490-83c9-cc57a80aea09/workspace-admin.html';
const temporary = await mkdtemp('/private/tmp/wiki-admin-v5-');
const fragment = await readFile(fragmentPath, 'utf8');
const url = `file://${temporary}/admin.html`;
await writeFile(
  `${temporary}/admin.html`,
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${fragment}</body></html>`,
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const checks = [],
  errors = [],
  requests = [],
  screenshots = [],
  metrics = {};
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
await page.addInitScript(() => {
  window.snapshots = [];
  window.openai = {
    widgetState: {
      privateContent: {
        version: 4,
        path: '/admin/history',
        stress: false,
        searches: {},
      },
    },
    setWidgetState: async (value) => {
      window.snapshots.push(value);
    },
  };
});
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const icon = (name) => page.getByRole('button', { name, exact: true });
const nav = (name) =>
  page
    .getByRole('navigation', { name: '관리 탐색' })
    .getByRole('link', { name, exact: true });
const list = (label) =>
  page.getByRole('list', { name: `${label} 결과`, exact: true });
const rows = (label) => list(label).locator(':scope > li');
const ready = async (label) => {
  await expect(list(label)).toBeVisible();
  await expect(page.getByText('검색 중…', { exact: true })).toHaveCount(0);
};
const search = (label) =>
  page.getByRole('textbox', { name: `${label} 검색`, exact: true });
const screen = () => page.locator('[data-screen]:not([hidden])');
const setting = async (label, value) => {
  const control = page.getByLabel(label, { exact: true });
  const summary = page.locator('summary').filter({ hasText: '시안 설정' });
  if (!(await control.isVisible())) await summary.click();
  if (typeof value === 'boolean') await control.setChecked(value);
  else await control.selectOption(value);
  await summary.click();
};
const shot = async (name) => {
  await expect(page.getByText('검색 중…', { exact: true })).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, out)),
    fullPage: true,
    animations: 'disabled',
  });
  screenshots.push(`${name}.png`);
};
const reset = async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await ready('워크스페이스 목록');
};
const attempts = async () =>
  page.evaluate(() => window.__adminProposalTest.attempts());
const noOverflow = async (context) =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    context,
  );
const style = async (locator) =>
  locator.evaluate((element) => {
    const value = getComputedStyle(element),
      box = element.getBoundingClientRect();
    return {
      border: value.borderTopColor,
      background: value.backgroundColor,
      width: box.width,
      height: box.height,
      outline: value.outlineStyle,
      outlineWidth: value.outlineWidth,
      name: element.getAttribute('aria-label'),
    };
  });

try {
  await reset();
  await expect(
    page.getByRole('navigation', { name: '관리 탐색' }).getByRole('link'),
  ).toHaveCount(2);
  await expect(
    page
      .getByRole('navigation', { name: '관리 탐색' })
      .getByRole('link', { name: '변경 이력' }),
  ).toHaveCount(0);

  // 실제 제품 SCSS를 독립 기준 요소에 적용합니다. 전체 제품 화면 렌더 검증과 구분합니다.
  const productCss = [
    new URL('../../src/renderer/app/AppShell.module.scss', import.meta.url),
    new URL(
      '../../src/renderer/features/browse-ai-sessions/ui/AiSessions.module.scss',
      import.meta.url,
    ),
  ]
    .map((file) => compile(fileURLToPath(file)).css)
    .join('\n');
  await page.addStyleTag({ content: productCss });
  await page.evaluate(() => {
    const wrapper = document.createElement('div');
    wrapper.id = 'product-icon-reference';
    wrapper.className = 'wiki-theme';
    wrapper.dataset.wikiTheme = 'light';
    wrapper.innerHTML =
      '<button class="backButton" aria-label="제품 뒤로가기 기준"></button><div class="root"><button class="moreAction" aria-label="제품 더보기 기준"></button></div>';
    document.body.append(wrapper);
  });
  metrics.productBack = await style(icon('제품 뒤로가기 기준'));
  metrics.productMore = await style(icon('제품 더보기 기준'));
  assert.equal(metrics.productBack.border, 'rgba(0, 0, 0, 0)');
  assert.equal(metrics.productBack.background, 'rgba(0, 0, 0, 0)');
  assert.equal(metrics.productBack.width, 36);
  assert.equal(metrics.productMore.border, 'rgba(0, 0, 0, 0)');
  assert.equal(metrics.productMore.background, 'rgba(0, 0, 0, 0)');
  assert.equal(metrics.productMore.width, 32);
  await page.evaluate(() =>
    document.querySelector('#product-icon-reference').remove(),
  );
  await reset();
  metrics.adminIcon = await style(icon('SDV 플랫폼 이름 편집'));
  assert.equal(metrics.adminIcon.border, metrics.productMore.border);
  assert.equal(metrics.adminIcon.background, metrics.productMore.background);
  assert.equal(metrics.adminIcon.width, metrics.productMore.width);
  assert.equal(metrics.adminIcon.name, 'SDV 플랫폼 이름 편집');
  await icon('SDV 플랫폼 이름 편집').hover();
  await expect(icon('SDV 플랫폼 이름 편집')).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.getByRole('tooltip')).toHaveText('SDV 플랫폼 이름 편집');
  await icon('SDV 플랫폼 이름 편집').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  metrics.adminIconFocus = await style(icon('SDV 플랫폼 이름 편집'));
  assert.equal(metrics.adminIconFocus.outline, 'solid');
  assert(parseFloat(metrics.adminIconFocus.outlineWidth) >= 2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await shot('workspaces-icons-light-1280');
  check(
    '전역 이력 메뉴 제거, 제품 back/more SCSS와 같은 투명 아이콘 테두리·배경, 이름·hover·focus·Escape 유지',
  );

  await setting('대규모 자료 240명', true);
  await nav('사용자').click();
  await ready('사용자 목록');
  await icon('배정 대기').click();
  await search('사용자 목록').fill('person-1');
  await expect(rows('사용자 목록')).toHaveCount(20);
  await icon('다음 페이지').click();
  await expect(page.getByText('21–40 / 100', { exact: true })).toBeVisible();
  const personName = await rows('사용자 목록')
    .first()
    .locator('h3')
    .innerText();
  await rows('사용자 목록')
    .first()
    .getByRole('button', { name: /워크스페이스 배정$/ })
    .click();
  await ready('배정할 워크스페이스');
  await expect(nav('사용자')).toHaveAttribute('aria-current', 'page');
  await search('배정할 워크스페이스').fill('연구');
  await expect(rows('배정할 워크스페이스')).toHaveCount(20);
  await icon('다음 페이지').click();
  await expect(page.getByText('21–40 / 54', { exact: true })).toBeVisible();
  const spaceName = await rows('배정할 워크스페이스')
    .first()
    .locator('h3')
    .innerText();
  await shot('assignment-workspace-picker-light-1280');
  await icon(spaceName).click();
  await page.getByRole('checkbox', { name: '위키 편집', exact: true }).check();
  await icon('뒤로가기').click();
  await ready('배정할 워크스페이스');
  await expect(search('배정할 워크스페이스')).toHaveValue('연구');
  await expect(page.getByText('21–40 / 54', { exact: true })).toBeVisible();
  await icon(spaceName).click();
  await expect(
    page.getByRole('checkbox', { name: '위키 편집', exact: true }),
  ).toBeChecked();
  await icon('뒤로가기').click();
  await ready('배정할 워크스페이스');
  await icon('뒤로가기').click();
  await ready('사용자 목록');
  await expect(search('사용자 목록')).toHaveValue('person-1');
  await expect(icon('배정 대기')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('21–40 / 100', { exact: true })).toBeVisible();
  assert.equal((await attempts()).length, 0);
  check(
    'A: 상단 뒤로가기는 권한→공간 선택→실제 출발 목록 순서, 선택 검색·페이지와 권한 초안·출발 필터 보존',
  );

  await icon(personName).first().click();
  await expect(icon(`${personName} 워크스페이스 배정`)).toBeVisible();
  await icon(`${personName} 워크스페이스 배정`).click();
  await expect(screen()).toHaveAttribute('data-screen', '/admin/assign');
  await page
    .getByRole('navigation', { name: '현재 위치' })
    .getByRole('link', { name: personName, exact: true })
    .click();
  await expect(screen()).toHaveAttribute('data-screen', '/admin/user');
  await icon('뒤로가기').click();
  await ready('사용자 목록');
  await expect(screen()).toHaveAttribute('data-screen', '/admin/users');
  await rows('사용자 목록')
    .first()
    .getByRole('button', { name: /워크스페이스 배정$/ })
    .click();
  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  await expect(icon('뒤로가기')).toHaveCount(0);
  await icon('SDV 플랫폼').click();
  await ready('멤버 목록');
  await icon('뒤로가기').click();
  await ready('워크스페이스 목록');
  await expect(icon('뒤로가기')).toHaveCount(0);
  check(
    'B: breadcrumb 상위 이동 뒤 하위 배정으로 순환하지 않음; 일반 메뉴는 작업 탐색 이력을 초기화',
  );

  await reset();
  await icon('SDV 플랫폼').click();
  await ready('멤버 목록');
  await icon('박지호 권한 편집').click();
  await page
    .getByRole('checkbox', { name: '원본 등록', exact: true })
    .uncheck();
  await page.getByRole('checkbox', { name: '대화 기록', exact: true }).check();
  await icon('권한 저장').click();
  await ready('멤버 목록');
  await page.getByRole('tab', { name: '변경 이력', exact: true }).click();
  const audit = page.getByRole('list', { name: '변경 이력 결과', exact: true });
  await expect(audit.locator(':scope > li').first()).toContainText(
    '추가 대화 기록',
  );
  await expect(audit.locator(':scope > li').first()).toContainText(
    '회수 원본 등록',
  );
  metrics.historyRows = await audit
    .locator(':scope > li')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        height: element.getBoundingClientRect().height,
        text: element.innerText,
      })),
    );
  assert(
    metrics.historyRows.every((row) => row.height <= 72),
    'Normal desktop history rows should remain near the compact 64px target',
  );
  await shot('workspace-history-light-1280');
  const completeDiff = (await audit.locator(':scope > li').first().innerText())
    .replace(/\s+/g, ' ')
    .trim();
  for (const width of [1280, 736, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await setting('시안 테마', theme);
      await expect(audit).toBeVisible();
      await noOverflow(`history ${width} ${theme}`);
      assert.equal(
        (await audit.locator(':scope > li').first().innerText())
          .replace(/\s+/g, ' ')
          .trim(),
        completeDiff,
      );
      await shot(`history-${theme}-${width}`);
    }
  await page.setViewportSize({ width: 1280, height: 900 });
  await setting('시안 테마', 'light');
  await nav('사용자').click();
  await ready('사용자 목록');
  await search('사용자 목록').fill('박지호');
  await icon('박지호').click();
  await page.getByRole('tab', { name: '변경 이력', exact: true }).click();
  await expect(audit.locator(':scope > li')).toHaveCount(2);
  await expect(audit.locator(':scope > li').first()).toContainText(
    '추가 대화 기록',
  );
  await expect(audit.locator(':scope > li').first()).toContainText(
    '회수 원본 등록',
  );
  await page.getByRole('button', { name: /^워크스페이스 ·/ }).click();
  await ready('필터 워크스페이스');
  await icon('SDV 플랫폼').click();
  await expect(screen()).toHaveAttribute('data-screen', '/admin/user');
  await expect(
    page.getByRole('tab', { name: '변경 이력', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(nav('사용자')).toHaveAttribute('aria-current', 'page');
  await expect(audit.locator(':scope > li')).toHaveCount(2);
  await shot('user-history-light-1280');
  await icon('뒤로가기').click();
  await ready('사용자 목록');
  await expect(search('사용자 목록')).toHaveValue('박지호');
  check(
    '공간·사용자 상세 안의 이력과 범위 검색 유지, 정확한 추가·회수 확인, 작은 화면 줄바꿈에서 정보 보존 및 행 밀도 축소',
  );

  await reset();
  await icon('SDV 플랫폼').click();
  await ready('멤버 목록');
  await icon('기존 사용자 추가').click();
  await ready('추가할 사용자');
  for (let index = 0; index < 4; index++)
    await rows('추가할 사용자').nth(index).getByRole('checkbox').check();
  await page.getByRole('button', { name: /^권한 설정/ }).click();
  await setting('시안 상태', 'partial');
  await icon('선택한 사용자 배정').click();
  await expect(page.locator('[data-status=unknown]')).toHaveCount(1);
  await expect(icon('결과 확인')).toBeEnabled();
  const firstAttempts = await attempts();
  assert.equal(firstAttempts.length, 3);
  await expect(icon('완료')).toHaveCount(0);
  await icon('뒤로가기').click();
  await ready('멤버 목록');
  await icon('기존 사용자 추가').click();
  await expect(page.locator('[data-status=unknown]')).toHaveCount(1);
  await expect(
    page.getByRole('group', { name: '자료', exact: true }),
  ).toHaveCount(0);
  assert.deepEqual(await attempts(), firstAttempts);
  await icon('결과 확인').click();
  assert.deepEqual(await attempts(), firstAttempts);
  await icon('미완료 다시 시도').click();
  await expect(page.locator('[data-status=success]')).toHaveCount(4);
  const finalAttempts = await attempts();
  assert.equal(finalAttempts.length, 5);
  for (const index of [0, 2])
    assert.equal(
      finalAttempts.filter(
        (entry) => entry.userId === firstAttempts[index].userId,
      ).length,
      1,
    );
  await icon('완료').click();
  await ready('멤버 목록');
  check(
    '결과 단계 뒤로가기·재진입은 미확인 결과를 보존, 영수증 확인은 쓰기 0, 완료 대상 재전송 0',
  );

  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  for (const width of [1280, 736, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await setting('시안 테마', theme);
      await ready('워크스페이스 목록');
      await noOverflow(`workspaces ${width} ${theme}`);
      assert.equal(
        (await style(icon('SDV 플랫폼 이름 편집'))).border,
        'rgba(0, 0, 0, 0)',
      );
      if (width === 320) await shot(`workspaces-icons-${theme}-${width}`);
    }
  const touch = await browser.newPage({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
  });
  await touch.goto(url);
  const touchIcon = touch.getByRole('button', {
    name: 'SDV 플랫폼 이름 편집',
    exact: true,
  });
  await expect(touchIcon).toBeVisible();
  metrics.touchIcon = await style(touchIcon);
  assert(metrics.touchIcon.width >= 44 && metrics.touchIcon.height >= 44);
  await touch.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  check(
    '선택한 화면 320/736/1280 밝음·어두움 가로넘침 없음, 터치 아이콘 44px, 브라우저 오류·외부 요청 없음',
  );
  await writeFile(
    new URL('results.json', out),
    JSON.stringify(
      {
        passed: true,
        checks,
        metrics,
        screenshots,
        errors,
        requests,
        verifiedAt: new Date().toISOString(),
        scope:
          'v5 세 피드백에 대한 모의 콘솔 기능·동선·시각 검증; 실제 관리자 API 또는 사용자 사용성 승인 아님',
        productReference:
          '제품 SCSS를 임시 기준 요소에 적용한 계산 스타일; 전체 제품 컴포넌트 렌더 아님',
        previousEvidence: '../admin-console-v4/',
      },
      null,
      2,
    ) + '\n',
  );
  await rm(new URL('failure.png', out), { force: true });
  await rm(new URL('failure.json', out), { force: true });
} catch (error) {
  await page
    .screenshot({
      path: fileURLToPath(new URL('failure.png', out)),
      fullPage: true,
    })
    .catch(() => undefined);
  await writeFile(
    new URL('failure.json', out),
    JSON.stringify(
      {
        passed: false,
        checks,
        metrics,
        error: String(error),
        errors,
        requests,
        text: await page
          .locator('body')
          .innerText()
          .catch(() => ''),
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
