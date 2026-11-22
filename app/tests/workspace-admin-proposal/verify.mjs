import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const out = new URL('./verification/admin-console/', import.meta.url);
await mkdir(out, { recursive: true });
const url =
  process.argv[2] ??
  'file:///Users/jong-yu/.codex/visualizations/2026/11/16/01a1e40f-f625-7490-83c9-cc57a80aea09/workspace-admin.html';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [],
  requests = [],
  checks = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const captures = new Set([
  'workspaces-light-1280',
  'users-light-1280',
  'history-light-1280',
  'workspaces-dark-1280',
  'permissions-light-320',
  'conflict',
]);
const shot = async (name) => {
  if (captures.has(name))
    await page.screenshot({
      path: fileURLToPath(new URL(`${name}.png`, out)),
      fullPage: true,
      animations: 'disabled',
    });
};
const nav = (name) =>
  page
    .getByRole('navigation', { name: '서버 관리 메뉴' })
    .getByRole('button', { name, exact: true });
try {
  await page.addInitScript(() => {
    window.openai = {
      widgetState: {
        privateContent: {
          view: 'entry',
          selected: 'sdv-platform',
          tab: 'general',
          workspaces: [],
        },
      },
      setWidgetState: async () => {},
    };
  });
  await page.goto(url);
  await expect(
    page.getByText('LLM Wiki 관리 콘솔', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: '전체 워크스페이스' }),
  ).toBeVisible();
  await expect(
    page.getByText('admin-local-01 · 서버 관리자', { exact: true }),
  ).toBeVisible();
  for (const old of ['문서', 'AI 채팅', 'AI 세션', '설정', '현재 작업 공간'])
    await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '연결 설정', exact: true }),
  ).toHaveCount(0);
  await shot('workspaces-light-1280');
  check(
    '독립 관리자 신원·전체 공간 목록, 일반 업무 프레임 제거, 이전 entry 저장 상태 거부',
  );
  await page.getByRole('button', { name: 'SDV 플랫폼 관리 열기' }).click();
  await expect(
    page.getByRole('heading', { name: 'SDV 플랫폼', exact: true }),
  ).toBeVisible();
  const name = page.getByRole('textbox', {
    name: '워크스페이스 이름',
    exact: true,
  });
  await name.fill('SDV 플랫폼 연구팀');
  await page.getByRole('tab', { name: '멤버 권한', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: '변경 이력', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: '이 공간의 변경 이력' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '일반', exact: true }).click();
  await expect(name).toHaveValue('SDV 플랫폼 연구팀');
  await page.getByLabel('시안 상태').selectOption('conflict');
  await page.getByRole('button', { name: '이름 변경 저장' }).click();
  await expect(
    page.getByText('다른 관리자가 이름을 변경했습니다'),
  ).toBeVisible();
  await expect(name).toHaveValue('SDV 플랫폼 연구팀');
  await shot('conflict');
  await page
    .getByRole('button', { name: '두 값을 확인하고 다시 편집' })
    .click();
  await name.fill('SDV 플랫폼 연구팀');
  await page.getByRole('button', { name: '이름 변경 저장' }).click();
  await page.getByLabel('시안 상태').selectOption('normal');
  await name.fill('SDV 플랫폼');
  await page.getByRole('button', { name: '이름 변경 저장' }).click();
  check('기존 공간 관리·탭 키보드·초안 보존·충돌 비교 후 명시 저장');
  await nav('사용자').click();
  const userTable = page.getByRole('table', { name: '서버 사용자' });
  await expect(
    userTable.getByRole('row').filter({ hasText: '이하린' }),
  ).toContainText('SDV 플랫폼');
  await expect(
    userTable.getByRole('row').filter({ hasText: '이하린' }),
  ).toContainText('기술 리서치');
  await page.getByRole('button', { name: '이하린 소속 관리' }).click();
  await shot('users-light-1280');
  await page
    .getByRole('button', { name: '기술 리서치에서 이하린 권한 관리' })
    .click();
  await expect(
    page.getByRole('heading', { name: '이하린의 업무 권한' }),
  ).toBeVisible();
  await expect(page.getByLabel('자료 읽기', { exact: true })).toBeChecked();
  await page.getByLabel('위키 편집', { exact: true }).check();
  await page.getByRole('button', { name: '권한 변경 저장' }).click();
  await expect(
    page.getByText('이하린 · 업무 권한 변경', { exact: true }),
  ).toBeVisible();
  check('서버 사용자 전체 소속→정확한 공간·사용자의 기존 권한 편집');
  await nav('변경 이력').click();
  const history = page.getByRole('table', { name: '설정 변경 이력' });
  await expect(
    history.getByRole('row').filter({ hasText: '업무 권한 변경' }),
  ).toContainText('이하린');
  await expect(
    history.getByRole('row').filter({ hasText: '업무 권한 변경' }),
  ).toContainText('admin-local-01');
  await shot('history-light-1280');
  await page.getByLabel('워크스페이스 필터').selectOption('research');
  await page.getByLabel('대상 사용자 필터').selectOption('harin');
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await history
    .getByRole('button', { name: '기술 리서치', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '이 공간의 변경 이력' }),
  ).toBeVisible();
  check(
    '전체 감사 이력의 공간·대상 사용자·관리자 구분, AND 필터와 공간 상세 연결',
  );
  await page.getByRole('tab', { name: '멤버 권한', exact: true }).click();
  await page.getByRole('button', { name: '제외', exact: true }).nth(1).click();
  await expect(
    page.getByText(/문서·히스토리·개인 기록은 삭제하지 않습니다/),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '공간에서 제외', exact: true })
    .click();
  await nav('사용자').click();
  await expect(
    userTable.getByRole('row').filter({ hasText: '이하린' }),
  ).not.toContainText('기술 리서치');
  check('소속 제외 후 서버 사용자 목록에 반영, 문서 보존 안내 유지');
  await nav('워크스페이스').click();
  await page
    .getByRole('button', { name: '워크스페이스 생성', exact: true })
    .click();
  await page.getByRole('button', { name: '워크스페이스 만들기' }).click();
  await expect(
    page.getByText('워크스페이스 이름을 입력해 주세요.'),
  ).toBeVisible();
  await page.getByLabel('이름', { exact: true }).fill('검증 공간');
  await page
    .getByLabel('워크스페이스 식별자', { exact: true })
    .fill('verification');
  await page.getByRole('button', { name: '워크스페이스 만들기' }).click();
  await expect(
    page.getByRole('heading', { name: '멤버 0명', exact: true }),
  ).toBeVisible();
  check('보조 생성 흐름·입력 검증·멤버 없이 공간 생성');
  for (const width of [1280, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('시안 테마').selectOption(theme);
      for (const screen of ['워크스페이스', '사용자', '변경 이력']) {
        await nav(screen).click();
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `${width}/${theme}/${screen} overflow`,
        );
        if (screen === '워크스페이스')
          await shot(`workspaces-${theme}-${width}`);
      }
      await nav('워크스페이스').click();
      await page.getByRole('button', { name: 'SDV 플랫폼 관리 열기' }).click();
      await page.getByRole('tab', { name: '멤버 권한', exact: true }).click();
      await page
        .getByRole('button', { name: '권한 변경', exact: true })
        .first()
        .click();
      await expect(
        page.getByRole('button', { name: '권한 변경 저장' }),
      ).toBeVisible();
      assert.equal(
        await page
          .getByRole('button', { name: '권한 변경 저장' })
          .evaluate((button) => getComputedStyle(button).color),
        'rgb(255, 255, 255)',
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${width}/${theme}/permissions overflow`,
      );
      await shot(`permissions-${theme}-${width}`);
      await page.getByRole('button', { name: '취소', exact: true }).click();
    }
  }
  check(
    '1280/736/320px × 밝음/어두움: 전체 공간·사용자·감사 이력·권한 폼 가로 넘침 없음',
  );
  await page.getByRole('tab', { name: '일반', exact: true }).click();
  await name.fill('관리 인증 후 이어 쓸 초안');
  await page.getByLabel('시안 상태').selectOption('expired');
  await expect(
    page.getByRole('heading', { name: '관리자 인증이 필요합니다' }),
  ).toBeVisible();
  await expect(name).not.toBeVisible();
  await page.getByRole('button', { name: '인증된 시안으로 돌아가기' }).click();
  await expect(name).toHaveValue('관리 인증 후 이어 쓸 초안');
  await page.getByLabel('시안 상태').selectOption('denied');
  await expect(
    page.getByRole('heading', { name: '관리 권한이 없습니다' }),
  ).toBeVisible();
  check('관리 인증 만료·권한 없음 자료 숨김, 같은 인증 모의 복귀 초안 유지');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  check('브라우저 오류 0·HTTP/외부 요청 0');
  await writeFile(
    new URL('results.json', out),
    JSON.stringify(
      {
        schemaVersion: 2,
        verified: '2026-11-16',
        checks,
        errors,
        externalRequests: requests,
        scope:
          'Independent admin console prototype; synthetic UI only; no backend/auth/storage verification',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
