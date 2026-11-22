import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = new URL('./verification/admin-console-v4/', import.meta.url);
await mkdir(out, { recursive: true });
const fragmentPath =
  process.argv[2] ??
  '/Users/jong-yu/.codex/visualizations/2026/11/16/01a1e40f-f625-7490-83c9-cc57a80aea09/workspace-admin.html';
const temporary = await mkdtemp('/private/tmp/wiki-admin-v4-');
const wrap = async (source, name) => {
  const fragment = await readFile(source, 'utf8');
  const destination = `${temporary}/${name}.html`;
  await writeFile(
    destination,
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${fragment}</body></html>`,
  );
  return `file://${destination}`;
};
const url = await wrap(fragmentPath, 'admin');
const baselineUrl = await wrap(
  '/private/tmp/wiki-template-baseline-fragment.html',
  'baseline',
);
const previous = JSON.parse(
  await readFile(
    new URL('./verification/admin-console-v3/results.json', import.meta.url),
    'utf8',
  ),
);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const checks = [],
  errors = [],
  requests = [],
  geometry = {},
  screenshots = [],
  hostSnapshots = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
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
  if (!(await control.isVisible()))
    await page.locator('summary').filter({ hasText: '시안 설정' }).click();
  if (typeof value === 'boolean') await control.setChecked(value);
  else await control.selectOption(value);
  await page.locator('summary').filter({ hasText: '시안 설정' }).click();
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
const measure = async () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-sidebar-open]');
    const css = getComputedStyle(root);
    return {
      mode: document.compatMode,
      header: root.querySelector('header').getBoundingClientRect().height,
      sidebar: root.querySelector('aside').getBoundingClientRect().width,
      footer: root.querySelector('footer').getBoundingClientRect().height,
      font: css.fontSize,
      line: css.lineHeight,
      background: css.backgroundColor,
      search: root
        .querySelector('input')
        ?.closest('label')
        .getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
const collectSnapshots = async () =>
  hostSnapshots.push(...(await page.evaluate(() => window.snapshots ?? [])));
const reset = async () => {
  await collectSnapshots();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await ready('워크스페이스 목록');
};
const noOverflow = async (context) =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    context,
  );
const attempts = async () =>
  page.evaluate(() => window.__adminProposalTest.attempts());

try {
  await page.goto(baselineUrl);
  await expect(page.getByRole('list', { name: '템플릿 목록' })).toBeVisible();
  geometry.product = await measure();
  await shot('product-list-baseline-1280');
  await page.addInitScript(() => {
    window.snapshots = [];
    window.openai = {
      widgetState: {
        privateContent: {
          version: 3,
          path: '/admin/user?id=minseo',
          stress: false,
          searches: {},
        },
      },
      setWidgetState: async (value) => {
        window.snapshots.push(value);
      },
    };
  });
  await page.goto(url);
  await ready('워크스페이스 목록');
  geometry.admin = await measure();
  geometry.previous = previous.geometry.admin;
  for (const key of [
    'mode',
    'header',
    'sidebar',
    'footer',
    'font',
    'line',
    'background',
    'search',
  ]) {
    assert.equal(geometry.admin[key], geometry.product[key], key);
    assert.equal(geometry.admin[key], geometry.previous[key], `v3 ${key}`);
  }
  for (const name of ['문서', 'AI 채팅', 'AI 세션', '설정'])
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(page.locator('[data-screen] select')).toHaveCount(0);
  await shot('workspaces-light-1280');
  check(
    '구버전 상태 거부, 관리 전용 탐색, 제품 및 고정 v3 프레임·타이포·검색 크기 일치',
  );

  // 각 과업은 아래에서 실제 목록·폼·복귀 결과로 확인합니다.

  await setting('대규모 자료 240명', true);
  await nav('사용자').click();
  await ready('사용자 목록');
  await expect(rows('사용자 목록')).toHaveCount(20);
  await expect(page.getByText('1–20 / 240', { exact: true })).toBeVisible();
  await icon('다음 페이지').click();
  await expect(page.getByText('21–40 / 240', { exact: true })).toBeVisible();
  const returnedName = await rows('사용자 목록')
    .first()
    .locator('h3')
    .innerText();
  await icon(returnedName).first().click();
  await expect(list('사용자 목록')).toHaveCount(0);
  await expect(page.getByRole('main')).toBeFocused();
  await icon('뒤로가기').click();
  await expect(page.getByText('21–40 / 240', { exact: true })).toBeVisible();
  await expect(icon(returnedName).first()).toBeFocused();
  await search('사용자 목록').fill('김민서');
  await expect(rows('사용자 목록')).toHaveCount(2);
  await expect(
    list('사용자 목록').getByText('minseo', { exact: true }),
  ).toBeVisible();
  await expect(
    list('사용자 목록').getByText('minseo-research', { exact: true }),
  ).toBeVisible();
  await search('사용자 목록').fill('person-100');
  await expect(rows('사용자 목록')).toHaveCount(1);
  await search('사용자 목록').fill('없는사용자');
  await expect(
    page.getByRole('heading', { name: '검색 결과가 없습니다' }),
  ).toBeVisible();
  await icon('검색어 지우기').click();
  await expect(rows('사용자 목록')).toHaveCount(20);
  check(
    '240명도 20개씩 표시, 이름·고정 ID·동명 검색, 상세와 목록 분리, 페이지·초점 복귀',
  );

  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  await expect(rows('워크스페이스 목록')).toHaveCount(20);
  await icon('SDV 플랫폼').click();
  await ready('멤버 목록');
  await icon('기존 사용자 추가').click();
  await ready('추가할 사용자');
  await expect(rows('추가할 사용자')).toHaveCount(20);
  await rows('추가할 사용자').first().getByRole('checkbox').check();
  await icon('다음 페이지').click();
  await expect(page.getByText('21–40 / 156', { exact: true })).toBeVisible();
  await rows('추가할 사용자').first().getByRole('checkbox').check();
  await expect(page.getByLabel('선택한 항목').locator('button')).toHaveCount(2);
  await page.getByRole('button', { name: /^권한 설정/ }).click();
  await page.getByRole('checkbox', { name: '위키 편집', exact: true }).check();
  await icon('선택 다시 하기').click();
  await expect(page.getByText('21–40 / 156', { exact: true })).toBeVisible();
  await expect(page.getByLabel('선택한 항목').locator('button')).toHaveCount(2);
  await page.getByRole('button', { name: /^권한 설정/ }).click();
  await expect(
    page.getByRole('checkbox', { name: '위키 편집', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('main')).toContainText('person-80');
  await expect(page.getByRole('main')).toContainText('person-100');
  check(
    '240명 조건의 별도 검색 선택 페이지도 20개 제한, 페이지를 넘긴 선택과 권한 단계 왕복 시 권한 초안 보존',
  );

  await reset();
  await setting('대규모 자료 240명', true);
  await nav('사용자').click();
  await ready('사용자 목록');
  await icon('배정 대기').click();
  await search('사용자 목록').fill('person-100');
  await expect(rows('사용자 목록')).toHaveCount(1);
  const waitingName = await rows('사용자 목록')
    .first()
    .locator('h3')
    .innerText();
  await shot('waiting-users-light-1280');
  await icon(`${waitingName} 워크스페이스 배정`).click();
  await ready('배정할 워크스페이스');
  await expect(nav('사용자')).toHaveAttribute('aria-current', 'page');
  await expect(list('사용자 목록')).toHaveCount(0);
  await expect(search('추가할 사용자')).toHaveCount(0);
  await expect(
    page.getByLabel('사용자 워크스페이스 배정', { exact: true }),
  ).toContainText(waitingName);
  await shot('user-fixed-workspace-search-light-1280');
  await icon('SDV 플랫폼').click();
  await expect(
    page.getByRole('group', { name: '자료', exact: true }),
  ).toBeVisible();
  await expect(list('배정할 워크스페이스')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '위키 편집', exact: true }).check();
  const assignmentSection = page.getByLabel('사용자 워크스페이스 배정', {
    exact: true,
  });
  const assignmentContext = await assignmentSection
    .getByText('배정할 사용자', { exact: true })
    .boundingBox();
  const assignmentSelection = await assignmentSection
    .getByText('워크스페이스', { exact: true })
    .boundingBox();
  const assignmentForm = await assignmentSection.locator('form').boundingBox();
  assert(assignmentContext && assignmentSelection && assignmentForm);
  assert(
    Math.abs(assignmentContext.x - assignmentForm.x) <= 4,
    'Fixed user context and permission form must share their left edge',
  );
  assert(
    Math.abs(assignmentSelection.x - assignmentForm.x) <= 4,
    'Workspace selection and permission form must share their left edge',
  );
  await shot('assignment-permissions-light-1280');
  await icon('배정').click();
  await expect(page.locator('[data-status=success]')).toHaveCount(1);
  await icon('완료').click();
  await expect(search('사용자 목록')).toHaveValue('person-100');
  await expect(icon('배정 대기')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows('사용자 목록')).toHaveCount(0);
  await icon('변경 이력').click();
  await expect(
    page
      .getByRole('list', { name: '변경 이력 결과', exact: true })
      .locator('li'),
  ).toHaveCount(1);
  await expect(
    page.getByRole('list', { name: '변경 이력 결과', exact: true }),
  ).toContainText(waitingName);
  await icon('뒤로가기').click();
  await expect(search('사용자 목록')).toHaveValue('person-100');
  await expect(icon('배정 대기')).toHaveAttribute('aria-pressed', 'true');
  await icon('소속 있음').click();
  await search('사용자 목록').fill('person-100');
  await expect(rows('사용자 목록')).toHaveCount(1);
  await expect(rows('사용자 목록').first()).toContainText('SDV 플랫폼');
  await icon(waitingName).click();
  await ready('소속 워크스페이스');
  await icon('SDV 플랫폼 권한 편집').click();
  await expect(
    page.getByRole('checkbox', { name: '위키 편집', exact: true }),
  ).toBeChecked();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: { globals: { widgetState: window.snapshots.at(-1) } },
      }),
    ),
  );
  await expect(
    page.getByRole('checkbox', { name: '위키 편집', exact: true }),
  ).toBeChecked();
  assert.equal((await attempts()).length, 1);
  check(
    '배정 대기 필터→행에서 사용자 고정→공간 검색→선택 권한 배정, 재검색 없이 원래 필터·검색 복귀와 상태 변화',
  );

  await reset();
  await icon('SDV 플랫폼').click();
  await ready('멤버 목록');
  await expect(list('워크스페이스 목록')).toHaveCount(0);
  await shot('workspace-members-light-1280');
  await icon('기존 사용자 추가').click();
  await ready('추가할 사용자');
  await expect(list('멤버 목록')).toHaveCount(0);
  const batchNames = (
    await rows('추가할 사용자').locator('h3').allTextContents()
  ).slice(0, 4);
  for (let index = 0; index < 4; index++)
    await rows('추가할 사용자').nth(index).getByRole('checkbox').check();
  await shot('member-search-light-1280');
  await page.getByRole('button', { name: /^권한 설정/ }).click();
  await expect(list('추가할 사용자')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '위키 편집', exact: true }).check();
  await setting('시안 상태', 'partial');
  await icon('선택한 사용자 배정').click();
  const outcomes = page
    .getByRole('list', { name: '개별 배정 결과' })
    .locator('[data-status]');
  await expect(outcomes).toHaveCount(4);
  await expect(page.locator('[data-status=unknown]')).toHaveCount(1);
  await expect(icon('결과 확인')).toBeEnabled();
  await expect(icon('완료')).toHaveCount(0);
  assert.deepEqual(
    await outcomes.evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.status),
    ),
    ['success', 'failed', 'unknown', 'unattempted'],
  );
  await expect(icon('미완료 다시 시도')).toBeDisabled();
  const firstAttempts = await attempts();
  assert.equal(firstAttempts.length, 3);
  await shot('assignment-partial-light-1280');
  await icon('결과 확인').click();
  assert.deepEqual(await attempts(), firstAttempts);
  await expect(page.locator('[data-status=success]')).toHaveCount(2);
  await icon('미완료 다시 시도').click();
  await expect(page.locator('[data-status=success]')).toHaveCount(4);
  const retried = await attempts();
  assert.equal(retried.length, 5);
  assert.equal(
    retried.filter((item) => item.userId === firstAttempts[0].userId).length,
    1,
  );
  assert.equal(
    retried.filter((item) => item.userId === firstAttempts[2].userId).length,
    1,
  );
  assert.equal(
    retried.filter((item) => item.userId === firstAttempts[1].userId).length,
    2,
  );
  await shot('assignment-complete-light-1280');
  await icon('완료').click();
  await ready('멤버 목록');
  await expect(rows('멤버 목록')).toHaveCount(11);
  await icon('변경 이력').click();
  for (const name of batchNames) {
    await page.getByRole('button', { name: /^사용자 ·/ }).click();
    await ready('필터 사용자');
    await icon(name).click();
    const records = page
      .getByRole('list', { name: '변경 이력 결과', exact: true })
      .locator('li');
    await expect(records).toHaveCount(1);
    await expect(records.first()).toContainText(name);
    await expect(records.first()).toContainText('자료 읽기');
    await expect(records.first()).toContainText('위키 편집');
  }
  check(
    '공간 첫 진입은 멤버, 선택 권한으로 일괄 배정; 부분 성공·실패·응답 유실·미실행 구별, 재확인 쓰기 0·완료 대상 재전송 0·사용자별 감사 기록 1개',
  );

  await reset();
  await nav('사용자').click();
  await ready('사용자 목록');
  await search('사용자 목록').fill('박지호');
  await expect(rows('사용자 목록')).toHaveCount(1);
  await icon('박지호').click();
  await ready('소속 워크스페이스');
  await icon('SDV 플랫폼 권한 편집').click();
  await page
    .getByRole('checkbox', { name: '원본 등록', exact: true })
    .uncheck();
  await page.getByRole('checkbox', { name: '대화 기록', exact: true }).check();
  await expect(
    page.getByLabel('권한 변경 내용', { exact: true }),
  ).toContainText('추가 대화 기록');
  await expect(
    page.getByLabel('권한 변경 내용', { exact: true }),
  ).toContainText('회수 원본 등록');
  await shot('permission-diff-light-1280');
  await icon('권한 저장').click();
  await ready('소속 워크스페이스');
  await icon('변경 이력').click();
  const audit = page.getByRole('list', { name: '변경 이력 결과', exact: true });
  await expect(audit.locator('li').first()).toContainText('박지호');
  await expect(audit.locator('li').first()).toContainText('추가 대화 기록');
  await expect(audit.locator('li').first()).toContainText('회수 원본 등록');
  await expect(
    page.getByRole('tab', { name: '변경 이력', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await shot('history-diff-light-1280');
  await icon('뒤로가기').click();
  await ready('소속 워크스페이스');
  await icon('뒤로가기').click();
  await ready('사용자 목록');
  await expect(search('사용자 목록')).toHaveValue('박지호');
  check(
    '기존 권한 변경의 실제 추가·회수 항목을 저장 전과 감사 이력에서 확인, 저장 알림→이력→사용자 상세→원래 검색 복귀',
  );

  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  await icon('SDV 플랫폼 변경 이력').click();
  await expect(audit).toBeVisible();
  await page.getByRole('button', { name: /^사용자 ·/ }).click();
  await ready('필터 사용자');
  await expect(audit).toHaveCount(0);
  await icon('박지호').click();
  await expect(audit).toBeVisible();
  await expect(
    page.getByRole('tab', { name: '변경 이력', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('navigation', { name: '현재 위치' }),
  ).toContainText('SDV 플랫폼');
  await audit
    .locator('li')
    .first()
    .getByRole('button', { name: '박지호', exact: true })
    .click();
  await ready('소속 워크스페이스');
  await icon('뒤로가기').click();
  await expect(audit).toBeVisible();
  await expect(
    page.getByRole('button', { name: '사용자 · 박지호', exact: true }),
  ).toBeVisible();
  await icon('뒤로가기').click();
  await ready('워크스페이스 목록');

  await nav('변경 이력').click();
  await expect(audit).toBeVisible();
  await page.getByRole('button', { name: /^워크스페이스 ·/ }).click();
  await ready('필터 워크스페이스');
  await icon('SDV 플랫폼').click();
  await page.getByRole('button', { name: /^사용자 ·/ }).click();
  await ready('필터 사용자');
  await icon('박지호').click();
  await expect(audit.locator('li')).toHaveCount(2);
  await audit
    .locator('li')
    .first()
    .getByRole('button', { name: 'SDV 플랫폼', exact: true })
    .click();
  await ready('멤버 목록');
  await icon('뒤로가기').click();
  await expect(audit).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: '워크스페이스 · SDV 플랫폼',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '사용자 · 박지호', exact: true }),
  ).toBeVisible();
  await expect(audit.locator('li')).toHaveCount(2);
  await shot('history-filters-light-1280');
  check(
    '공간 이력의 사용자 검색 후 공간 범위 유지, 이력→사용자/공간 상세→뒤로에서 전역·공간 필터와 원래 맥락 보존',
  );

  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  await icon('SDV 플랫폼 이름 편집').click();
  await expect(list('워크스페이스 목록')).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: '워크스페이스 이름', exact: true }),
  ).toBeVisible();
  await expect(screen()).toHaveAttribute(
    'data-screen',
    '/admin/workspace/edit',
  );
  geometry.renameForm = await screen().locator('form').boundingBox();
  await shot('workspace-rename-light-1280');
  await page
    .getByRole('textbox', { name: '워크스페이스 이름', exact: true })
    .fill('SDV 검증 공간');
  await icon('변경 저장').click();
  await ready('워크스페이스 목록');
  await expect(icon('SDV 검증 공간')).toBeVisible();
  await icon('변경 이력').click();
  await expect(audit.locator('li').first()).toContainText('이름 변경');
  await expect(audit.locator('li').first()).toContainText('SDV 플랫폼');
  await expect(audit.locator('li').first()).toContainText('SDV 검증 공간');
  await icon('뒤로가기').click();
  await ready('워크스페이스 목록');
  check(
    '목록 행에서 이름 편집→원래 목록 복귀→해당 변경 이력으로 이름 전후 확인',
  );

  await icon('워크스페이스 생성').click();
  await expect(
    page.getByRole('textbox', { name: '주소 이름', exact: true }),
  ).toBeVisible();
  await expect(screen()).toHaveAttribute('data-screen', '/admin/workspace/new');
  geometry.createForm = await screen().locator('form').boundingBox();
  assert(geometry.renameForm && geometry.createForm);
  assert.equal(
    geometry.createForm.x,
    geometry.renameForm.x,
    'Create and rename forms share the same starting edge',
  );
  assert.equal(
    geometry.createForm.width,
    geometry.renameForm.width,
    'Create and rename forms share the same form width',
  );
  await shot('workspace-create-light-1280');
  await icon('뒤로가기').click();
  await ready('워크스페이스 목록');
  check(
    '배정의 대상·선택·권한 폼 정렬 일치, 생성과 단독 이름 편집의 폼 위치·폭 일치',
  );

  await reset();
  await nav('사용자').click();
  await ready('사용자 목록');
  for (const width of [1280, 736, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await setting('시안 테마', theme);
      await ready('사용자 목록');
      await noOverflow(`users ${width} ${theme}`);
      await shot(`users-${theme}-${width}`);
    }
  await page.setViewportSize({ width: 1280, height: 900 });
  await icon('김민서').first().click();
  await ready('소속 워크스페이스');
  await icon('SDV 플랫폼 권한 편집').focus();
  await expect(page.getByRole('tooltip')).toHaveText('SDV 플랫폼 권한 편집');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('group', { name: '자료', exact: true }),
  ).toBeVisible();
  await expect(list('소속 워크스페이스')).toHaveCount(0);
  await expect(screen().locator('input[type=checkbox]')).toHaveCount(9);
  for (const width of [1280, 736, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await setting('시안 테마', theme);
      await noOverflow(`permissions ${width} ${theme}`);
      await shot(`permissions-${theme}-${width}`);
    }
  check(
    '목록·권한 320/736/1280 밝음·어두움 가로넘침 없음, 아이콘 focus·툴팁·Escape·Enter',
  );

  await page.evaluate(() => {
    const latest = window.snapshots.at(-1);
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: {
          globals: {
            widgetState: {
              ...latest,
              privateContent: {
                ...latest.privateContent,
                path: '/admin/history',
              },
            },
          },
        },
      }),
    );
  });
  await expect(
    page.getByRole('list', { name: '변경 이력 결과', exact: true }),
  ).toBeVisible();

  await collectSnapshots();
  for (const value of hostSnapshots) {
    assert(Buffer.byteLength(JSON.stringify(value)) < 16384);
    assert.equal(value.privateContent.version, 4);
  }
  assert(hostSnapshots.length > 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  check(
    'host v4 echo가 편집 자료를 보존하고 외부 상태 이벤트로 페이지 복원, 저장 크기 16KiB 미만, 브라우저 오류 및 외부 요청 없음',
  );
  await writeFile(
    new URL('results.json', out),
    JSON.stringify(
      {
        passed: true,
        checks,
        geometry,
        screenshots,
        errors,
        requests,
        verifiedAt: new Date().toISOString(),
        scope:
          '모의 관리자 콘솔의 기능·동선·시각 확인; 실제 관리자 API·사용성 승인 아님',
        previousEvidence: '../admin-console-v3/',
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
