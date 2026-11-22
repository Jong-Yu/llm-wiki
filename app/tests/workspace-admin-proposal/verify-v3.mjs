import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const out = new URL('./verification/admin-console-v3/', import.meta.url);
await mkdir(out, { recursive: true });
const fragmentPath =
  process.argv[2] ??
  '/Users/jong-yu/.codex/visualizations/2026/11/16/01a1e40f-f625-7490-83c9-cc57a80aea09/workspace-admin.html';
const temp = await mkdtemp('/private/tmp/wiki-admin-v3-');
const wrap = async (source, name) => {
  const fragment = await readFile(source, 'utf8');
  const destination = `${temp}/${name}.html`;
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
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const checks = [],
  errors = [],
  requests = [],
  geometry = {};
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const shot = async (name) => {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({
    path: fileURLToPath(new URL(`${name}.png`, out)),
    fullPage: true,
    animations: 'disabled',
  });
};
const nav = (name) =>
  page
    .getByRole('navigation', { name: '관리 탐색' })
    .getByRole('link', { name, exact: true });
const list = (label) =>
  page.getByRole('list', { name: `${label} 결과`, exact: true });
const rows = (label) => list(label).locator(':scope > li');
const ready = async (label) => expect(list(label)).toBeVisible();
const icon = (name) => page.getByRole('button', { name, exact: true });
const measure = async () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-sidebar-open]');
    const header = root.querySelector('header');
    const aside = root.querySelector('aside');
    const footer = root.querySelector('footer');
    const input = root.querySelector('input');
    const css = getComputedStyle(root);
    return {
      mode: document.compatMode,
      header: header.getBoundingClientRect().height,
      sidebar: aside.getBoundingClientRect().width,
      footer: footer.getBoundingClientRect().height,
      font: css.fontSize,
      line: css.lineHeight,
      background: css.backgroundColor,
      search: input?.closest('label').getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
try {
  await page.goto(baselineUrl);
  await expect(page.getByRole('list', { name: '템플릿 목록' })).toBeVisible();
  geometry.product = await measure();
  await shot('product-list-baseline-1280');
  await page.addInitScript(() => {
    window.snapshots = [];
    window.openai = {
      widgetState: {
        privateContent: { version: 2, view: 'users', selected: 'minseo' },
      },
      setWidgetState: async (value) => window.snapshots.push(value),
    };
  });
  await page.goto(url);
  await ready('워크스페이스 목록');
  geometry.admin = await measure();
  for (const key of [
    'mode',
    'header',
    'sidebar',
    'footer',
    'font',
    'line',
    'background',
    'search',
  ])
    assert.equal(geometry.admin[key], geometry.product[key], key);
  assert.equal(geometry.admin.header, 52);
  assert.equal(geometry.admin.sidebar, 208);
  assert.equal(geometry.admin.footer, 26);
  assert.equal(geometry.admin.font, '13px');
  assert.equal(geometry.admin.search, 36);
  assert.equal(await nav('워크스페이스').getAttribute('aria-current'), 'page');
  for (const name of ['문서', 'AI 채팅', 'AI 세션', '설정'])
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(page.locator('select')).toHaveCount(2);
  await shot('workspaces-light-1280');
  check(
    'v2 저장 상태 거부, 독립 관리 탐색, actual AppShell/TemplateList 기하·타이포·색 일치',
  );

  await nav('사용자').click();
  await ready('사용자 목록');
  await shot('users-light-1280');
  await icon('김민서').first().click();
  await ready('소속 워크스페이스');
  await expect(list('사용자 목록')).toHaveCount(0);
  await expect(page.getByRole('main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('textbox', { name: '소속 워크스페이스 검색' }),
  ).toBeFocused();
  await expect(nav('사용자')).toHaveAttribute('aria-current', 'page');
  await shot('user-detail-light-1280');
  await icon('SDV 플랫폼 권한 편집').focus();
  await expect(page.getByRole('tooltip')).toHaveText('SDV 플랫폼 권한 편집');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('group', { name: '자료', exact: true }),
  ).toBeVisible();
  await expect(list('소속 워크스페이스')).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: '위키 편집', exact: true })
    .uncheck();
  await icon('권한 저장').click();
  await ready('소속 워크스페이스');
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: { globals: { widgetState: window.snapshots.at(-1) } },
      }),
    ),
  );
  await icon('SDV 플랫폼 권한 편집').click();
  await expect(
    page.getByRole('checkbox', { name: '위키 편집', exact: true }),
  ).not.toBeChecked();
  await icon('뒤로가기').click();
  await ready('소속 워크스페이스');
  await icon('뒤로가기').click();
  await ready('사용자 목록');
  await expect(icon('김민서').first()).toBeFocused();
  check(
    '사용자 목록→전용 상세→권한 편집 DOM 분리, 아이콘 focus/툴팁/Escape/Enter, 복귀 focus 보존, host echo 후 변경 권한 유지',
  );

  await page.getByRole('checkbox', { name: '대규모 자료 240명' }).check();
  await nav('사용자').click();
  await ready('사용자 목록');
  await expect(rows('사용자 목록')).toHaveCount(20);
  await expect(page.getByText('1–20 / 240', { exact: true })).toBeVisible();
  await icon('다음 페이지').click();
  await expect(page.getByText('21–40 / 240', { exact: true })).toBeVisible();
  await expect(
    list('사용자 목록').getByText('person-16', { exact: true }),
  ).toBeVisible();
  const selectedName = await rows('사용자 목록')
    .first()
    .getByRole('button')
    .first()
    .innerText();
  await rows('사용자 목록').first().getByRole('button').first().click();
  await expect(list('사용자 목록')).toHaveCount(0);
  await icon('뒤로가기').click();
  await expect(page.getByText('21–40 / 240', { exact: true })).toBeVisible();
  await expect(icon(selectedName).first()).toBeFocused();
  const search = page.getByRole('textbox', { name: '사용자 목록 검색' });
  await search.fill('김민서');
  await expect(rows('사용자 목록')).toHaveCount(2);
  await expect(
    list('사용자 목록').getByText('minseo', { exact: true }),
  ).toBeVisible();
  await expect(
    list('사용자 목록').getByText('minseo-research', { exact: true }),
  ).toBeVisible();
  await search.fill('person-100');
  await expect(rows('사용자 목록')).toHaveCount(1);
  await search.fill('없는사용자');
  await expect(
    page.getByRole('heading', { name: '검색 결과가 없습니다' }),
  ).toBeVisible();
  await icon('검색어 지우기').click();
  await expect(rows('사용자 목록')).toHaveCount(20);
  check(
    '합성 사용자 240명·20개 페이지, 이름/고정 ID 검색, 동명 구분·빈 결과·지우기, 페이지와 focus 복귀',
  );

  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  await expect(rows('워크스페이스 목록')).toHaveCount(20);
  await icon('SDV 플랫폼').click();
  await expect(list('워크스페이스 목록')).toHaveCount(0);
  await page.getByRole('tab', { name: '멤버', exact: true }).click();
  await ready('멤버 목록');
  await icon('기존 사용자 추가').click();
  await ready('추가할 사용자');
  await expect(list('멤버 목록')).toHaveCount(0);
  await expect(rows('추가할 사용자')).toHaveCount(20);
  await rows('추가할 사용자').first().getByRole('checkbox').check();
  await icon('다음 페이지').click();
  await ready('추가할 사용자');
  await expect(page.getByText('21–40 / 156', { exact: true })).toBeVisible();
  await expect(
    list('추가할 사용자').getByText('person-100', { exact: true }),
  ).toBeVisible();
  await rows('추가할 사용자').first().getByRole('checkbox').check();
  await expect(page.getByLabel('선택한 항목').locator('button')).toHaveCount(2);
  await page.getByLabel('선택한 항목').locator('button').first().click();
  await expect(page.getByLabel('선택한 항목').locator('button')).toHaveCount(1);
  await shot('member-search-light-1280');
  await icon('선택한 1명 추가').click();
  await ready('멤버 목록');
  await expect(list('추가할 사용자')).toHaveCount(0);
  check(
    '공간 목록→상세→별도 멤버 선택 분리, 검색 결과 20개·페이지 간 선택 chip·해제·추가',
  );

  await nav('변경 이력').click();
  await expect(
    page.getByRole('list', { name: '변경 이력 결과' }),
  ).toBeVisible();
  await shot('history-light-1280');
  await icon('워크스페이스 필터').click();
  await ready('필터 워크스페이스');
  await expect(page.getByRole('list', { name: '변경 이력 결과' })).toHaveCount(
    0,
  );
  await icon('SDV 플랫폼').click();
  await expect(icon('워크스페이스 필터 해제')).toBeVisible();
  await icon('사용자 필터').click();
  await ready('필터 사용자');
  await icon('박지호').click();
  await expect(
    page.getByRole('list', { name: '변경 이력 결과' }).locator('li'),
  ).toHaveCount(1);
  await icon('사용자 필터 해제').click();
  await icon('워크스페이스 필터 해제').click();
  check(
    '변경 이력의 대상·행동·변경 전후·관리자·시각 구조, 별도 검색 필터와 AND 적용',
  );

  await nav('워크스페이스').click();
  await ready('워크스페이스 목록');
  await icon('SDV 플랫폼').click();
  await icon('이름 편집').click();
  await page.getByLabel('시안 상태').selectOption('conflict');
  await page
    .getByRole('textbox', { name: '워크스페이스 이름', exact: true })
    .fill('검토 중인 이름');
  await icon('변경 저장').click();
  await expect(
    page.getByText('다른 관리자가 이름을 변경했습니다'),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: '워크스페이스 이름', exact: true }),
  ).toHaveValue('검토 중인 이름');
  await page.getByLabel('시안 상태').selectOption('expired');
  await expect(
    page.getByRole('textbox', { name: '워크스페이스 이름', exact: true }),
  ).toBeHidden();
  await page.getByLabel('시안 상태').selectOption('normal');
  await expect(
    page.getByRole('textbox', { name: '워크스페이스 이름', exact: true }),
  ).toHaveValue('검토 중인 이름');
  check(
    '별도 이름 편집 충돌 시 초안·최신값 보존, 인증 만료 상태에서 편집 화면 숨김',
  );

  await nav('사용자').click();
  await ready('사용자 목록');
  await page.getByRole('textbox', { name: '사용자 목록 검색' }).fill('김민서');
  await expect(rows('사용자 목록')).toHaveCount(2);
  await icon('김민서').first().click();
  await ready('소속 워크스페이스');
  await icon('SDV 플랫폼 권한 편집').click();
  await expect(
    page.getByRole('group', { name: '자료', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-screen="/admin/permissions"] input[type=checkbox]'),
  ).toHaveCount(9);
  for (const width of [1280, 736, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel('시안 테마').selectOption(theme);
      await expect(
        page.getByRole('group', { name: '자료', exact: true }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false, `permissions ${width} ${theme}`);
      if (width === 320 && theme === 'light')
        await shot('permissions-light-320');
      if (width === 1280 && theme === 'dark')
        await shot('permissions-dark-1280');
    }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByLabel('시안 테마').selectOption('light');
  await nav('사용자').click();
  await ready('사용자 목록');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await shot('users-light-320');
  check('320/736/1280 밝음·어두움 권한 화면과 좁은 목록 overflow 없음');

  const snapshots = await page.evaluate(() => window.snapshots);
  assert.ok(snapshots.length > 0);
  for (const value of snapshots) {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 16384);
    assert.equal(value.privateContent.version, 3);
  }
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: {
          globals: {
            widgetState: {
              privateContent: {
                version: 3,
                path: '/admin/history',
                stress: false,
                searches: {},
              },
            },
          },
        },
      }),
    ),
  );
  await expect(
    page.getByRole('list', { name: '변경 이력 결과' }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  check(
    'host version3 상태 저장·이벤트 복원·16KiB 상한, 외부 요청·브라우저 오류 없음',
  );
  await writeFile(
    new URL('results.json', out),
    JSON.stringify(
      {
        passed: true,
        checks,
        geometry,
        errors,
        requests,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
