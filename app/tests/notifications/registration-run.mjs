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
const diagnostics = resolve(app, '../.local/diagnostics');
await mkdir(diagnostics, { recursive: true });
// 같은 검사를 다시 실행해도 이전 화면·검증 기록을 덮어쓰지 않습니다.
const destination = await mkdtemp(
  resolve(
    diagnostics,
    `${new Date().toISOString().slice(0, 10)}-notification-registration-ui-`,
  ),
);
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
      entry: resolve(here, 'registration-renderer.tsx'),
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
// 검증의 reset/open은 명시 폐기이며 저장 복원 검사는 별도로 완료 상태를 기다립니다.
page.on('dialog', (dialog) => dialog.accept());
const detail = `/documents?workflowId=${'1'.repeat(32)}`;
const list = () => page.getByRole('region', { name: '알림', exact: true });
const work = () =>
  page.getByRole('region', { name: '문서 내용 확인', exact: true });
const action = (name) => page.getByRole('button', { name, exact: true });
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
async function open(path = detail) {
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
  await expect(action('이 내용으로 등록 계속')).toBeEnabled();
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
      if (name === 'registration-content-editor')
        await page
          .getByRole('textbox', { name: '2페이지 등록할 내용' })
          .scrollIntoViewIfNeeded();
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

const editor = (number = 2) =>
  work().getByRole('textbox', {
    name: `${number}페이지 등록할 내용`,
    exact: true,
  });
async function recover() {
  await action('저장 결과 확인').click();
  await expect(action('이 내용으로 등록 계속')).toBeEnabled();
}
async function continued() {
  await expect
    .poll(async () => (await snapshot()).detail.workflow.state)
    .toBe('running');
}
try {
  await open('/notifications');
  await expect(list().locator('[data-notification-row]')).toHaveCount(5);
  const rowHeight = await list()
    .locator('[data-notification-row]')
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  assert.equal(rowHeight, 64);
  const filters = list().getByRole('group', { name: '알림 필터' });
  await expect(filters.getByRole('button', { name: /^전체/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    filters.getByRole('button', { name: /^내용 확인 필요/ }),
  ).toBeVisible();
  await layout('notification-list');
  await audit('notification-list');
  const iconDeleteButton = list().getByRole('button', {
    name: '합성 시스템 아키텍처 알림 삭제',
    exact: true,
  });
  assert.equal((await iconDeleteButton.textContent()).trim(), '');
  await iconDeleteButton.focus();
  await expect(
    page.getByRole('tooltip', {
      name: '합성 시스템 아키텍처 알림 삭제',
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await control('longTitle');
  await list().getByRole('button', { name: '새로고침', exact: true }).click();
  const longTitle = list()
    .locator('[data-notification-row] h2 span[tabindex="0"]')
    .first();
  await expect(longTitle).toContainText('매우 긴 파일 이름');
  assert.equal(
    await list()
      .locator('[data-notification-row]')
      .first()
      .evaluate((e) => e.getBoundingClientRect().height),
    rowHeight,
  );
  await longTitle.focus();
  await expect(page.getByRole('tooltip')).toContainText('매우 긴 파일 이름');
  await page.keyboard.press('Escape');
  await layout('notification-long-title');
  await reset('/notifications');
  await expect(list().locator('[data-notification-row]')).toHaveCount(5);
  pass(
    '알림 삭제는 아이콘 전용 / 키보드 설명·Escape / 긴 문서명에도 행·행동 위치 유지',
  );

  const filterPositions = () =>
    filters.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  const positions = await filterPositions();
  await control('fail', 'list');
  await filters.getByRole('button', { name: /^읽지 않음/ }).click();
  await expect(list().getByRole('alert')).toContainText('합성 네트워크 실패');
  assert.deepEqual(await filterPositions(), positions);
  await filters.getByRole('button', { name: /^전체/ }).click();
  await expect(list().getByRole('alert')).toHaveCount(0);
  assert.deepEqual(await filterPositions(), positions);
  pass('필터 변경·조회 실패·복구 동안 건수 배지와 버튼 위치 유지');
  const beforeDelete = await snapshot();
  const deleteButton = list().getByRole('button', {
    name: '합성 처리 기록 2 알림 삭제',
    exact: true,
  });
  await control('fail', 'dismiss');
  await deleteButton.click();
  await expect(list().getByRole('alert')).toContainText('합성 네트워크 실패');
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  await expect(deleteButton).toHaveCount(0);
  assert.deepEqual((await snapshot()).detail, beforeDelete.detail);
  await open('/notifications');
  await expect(deleteButton).toHaveCount(0);
  assert.equal((await snapshot()).items.length, beforeDelete.items.length - 1);
  pass(
    '알림 삭제 실패 시 행 유지 / 삭제 후 재접속 유지 / 문서와 작업 이력 보존',
  );
  await list().getByRole('button', { name: '표시된 알림 읽음' }).click();
  assert.equal((await snapshot()).calls.approve ?? 0, 0);
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  await filters.getByRole('button', { name: /^내용 확인 필요/ }).click();
  await expect(list().locator('[data-notification-row]')).toHaveCount(1);
  await expect(
    filters.getByRole('button', { name: /^내용 확인 필요/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  pass('읽음 처리 후에도 등록 내용 확인 필요 필터에 문서 유지');
  await list().getByRole('button', { name: '내용 확인', exact: true }).click();
  await available();
  pass(
    '알림 64px 행 유지 / 읽음은 실행하지 않음 / 같은 문서 내용 화면으로 이동',
  );
  assert.equal((await snapshot()).calls.decide ?? 0, 0);
  assert.equal((await snapshot()).calls.approve ?? 0, 0);
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  assert.ok((await work().getByRole('button').count()) < 10);
  await expect(
    work().getByRole('button', { name: /승인|보류|이 PC/ }),
  ).toHaveCount(0);
  await expect(work().locator('details')).toHaveCount(0);
  await expect(
    work().getByRole('link', { name: '문서로 돌아가기', exact: true }),
  ).toHaveCount(0);
  await expect(
    work().getByRole('img', { name: '등록한 PDF의 2페이지 원본' }),
  ).toBeVisible();
  await expect(editor()).toBeVisible();
  await action('2페이지').click();
  await expect(page.getByText('30개 확인 대상')).toBeVisible();
  await page.getByRole('combobox', { name: '탐색 범위' }).selectOption('all');
  await expect(page.getByText('170개 내용 구간')).toBeVisible();
  await page
    .getByRole('combobox', { name: '탐색 범위' })
    .selectOption('review');
  await page.keyboard.press('Escape');
  pass(
    '읽기만으로 실행하지 않음 / 페이지 30개는 선택 팝업 한곳 / 별도 승인 없음',
  );
  for (const width of [1280, 720, 320]) {
    for (const height of [900, 300]) {
      await page.setViewportSize({ width, height });
      const before = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      await action('2페이지').click();
      const picker = page.getByRole('group', {
        name: '페이지 선택',
        exact: true,
      });
      await expect(picker).toBeVisible();
      await settle();
      const rect = await picker.boundingBox();
      assert.ok(
        rect.x >= 11 &&
          rect.y >= 11 &&
          rect.x + rect.width <= width - 11 &&
          rect.y + rect.height <= height - 11,
        JSON.stringify({ width, height, rect }),
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        })),
        before,
      );
      await expect(
        picker.getByRole('spinbutton', { name: '이동할 위치' }),
      ).toBeVisible();
      await expect(
        picker.getByRole('spinbutton', { name: '이동할 위치' }),
      ).toBeFocused();
      await expect(
        picker.getByRole('combobox', { name: '탐색 범위' }),
      ).toHaveCount(1);
      if (height === 900) {
        const file = `registration-picker-${width}.png`;
        await page.screenshot({ path: resolve(destination, file) });
        screenshots.push(file);
      }
      await page.keyboard.press('Escape');
      await expect(picker).toHaveCount(0);
      await expect(action('2페이지')).toBeFocused();
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(action('이전 확인 페이지')).toHaveText('');
  await expect(action('다음 확인 페이지')).toHaveText('');
  pass(
    '페이지 선택창 3너비·낮은 창 경계 안 배치 / 문서 스크롤 크기 유지 / 닫기 초점 / chevron 탐색',
  );

  await editor().fill('첫 페이지에 사용자가 입력한 수정 내용');
  await action('다음 확인 페이지').click();
  await editor(7).fill('다음 페이지의 독립적인 수정 내용');
  await action('이전 확인 페이지').click();
  await expect(editor()).toHaveValue('첫 페이지에 사용자가 입력한 수정 내용');
  await layout('registration-content-editor');
  await audit('registration-content-editor');
  const before = (await snapshot()).trace.length;
  await action('이 내용으로 등록 계속').evaluate((element) => {
    element.click();
    element.click();
  });
  await continued();
  let state = await snapshot();
  assert.deepEqual(
    state.trace
      .slice(before)
      .filter((kind) =>
        ['correct', 'read', 'decide', 'approve', 'continue'].includes(kind),
      ),
    ['correct', 'read', 'correct', 'read', 'decide', 'approve', 'continue'],
  );
  assert.equal(state.calls.correct, 2);
  assert.equal(state.calls.decide, 1);
  assert.equal(state.calls.approve, 1);
  assert.equal(state.calls.continue, 1);
  assert.ok(
    state.detail.workflow.pages.every((entry) => entry.state === 'usable'),
  );
  assert.match(state.detail.conversion.components.page_2, /UI 검증 전용/);
  pass(
    '여러 페이지 초안 유지 / 보정 저장 확인 뒤 전 페이지 선택 / 한 번의 등록 계속 / 원 보고 보존',
  );

  for (const mode of ['fail', 'lose']) {
    await reset();
    await available();
    await editor().fill(`${mode} 뒤에도 보존할 내용`);
    await control(mode, 'correct');
    await action('이 내용으로 등록 계속').click();
    await expect(action('저장 결과 확인')).toBeVisible();
    await expect(editor()).toHaveValue(`${mode} 뒤에도 보존할 내용`);
    state = await snapshot();
    assert.equal(state.calls.decide ?? 0, 0);
    assert.equal(state.calls.approve ?? 0, 0);
    assert.equal(state.calls.continue ?? 0, 0);
    await recover();
    await action('이 내용으로 등록 계속').click();
    await continued();
    state = await snapshot();
    assert.equal(new Set(state.requests.correct).size, 1);
    assert.equal(state.detail.corrections.length, 1);
    pass(`수정 저장 ${mode}: 후속 처리 중단 / 최초 ID·내용으로 복구`);
  }

  await reset();
  await available();
  await editor().fill('저장은 성공하고 조회만 실패한 내용');
  await control('fail', 'read');
  await action('이 내용으로 등록 계속').click();
  await expect(action('저장 결과 확인')).toBeVisible();
  state = await snapshot();
  assert.equal(state.calls.correct, 1);
  assert.equal(state.calls.decide ?? 0, 0);
  await recover();
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal((await snapshot()).calls.correct, 1);
  pass('수정 저장 성공 후 조회 실패: 보정 재저장 없이 확인부터 재개');

  for (const step of ['decide', 'approve', 'continue']) {
    await reset();
    await available();
    await control('lose', step);
    await action('이 내용으로 등록 계속').click();
    await expect(action('저장 결과 확인')).toBeVisible();
    state = await snapshot();
    if (step === 'decide') assert.equal(state.calls.approve ?? 0, 0);
    if (step !== 'continue') assert.equal(state.calls.continue ?? 0, 0);
    if (step === 'continue') {
      await action('저장 결과 확인').click();
      await continued();
      await expect(action('이 내용으로 등록 계속')).toHaveCount(0);
      assert.equal((await snapshot()).calls.continue, 1);
    } else {
      await recover();
      await action('이 내용으로 등록 계속').click();
      await continued();
    }
    assert.equal(new Set((await snapshot()).requests[step]).size, 1);
    pass(`${step} 응답 유실: 원래 요청 확인 후 이어가기`);
  }

  await reset();
  await available();
  await editor().fill('충돌해도 지우지 않을 입력');
  await control('otherEdit');
  await action('이 내용으로 등록 계속').click();
  await expect(action('저장 결과 확인')).toBeVisible();
  await expect(editor()).toHaveValue('충돌해도 지우지 않을 입력');
  state = await snapshot();
  assert.equal(state.calls.decide ?? 0, 0);
  assert.equal(state.calls.approve ?? 0, 0);
  assert.equal(state.calls.continue ?? 0, 0);
  pass('다른 변경과 충돌하면 입력 보존하고 등록 중단');

  await reset();
  await available();
  await control('changeAfterDecision');
  await action('이 내용으로 등록 계속').click();
  await expect(action('저장 결과 확인')).toBeVisible();
  state = await snapshot();
  assert.equal(state.calls.approve ?? 0, 0);
  assert.equal(state.calls.continue ?? 0, 0);
  pass('페이지 선택 응답에 다른 보정 참조가 들어오면 확정·실행 중단');

  await reset(
    `${detail}&initialTarget=${encodeURIComponent('기존 등록 이름.md')}`,
    () => control('clearTarget'),
  );
  await available();
  await expect(
    work().getByRole('textbox', { name: '문서 저장 이름' }),
  ).toHaveCount(0);
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(
    (await snapshot()).detail.workflow.target_document,
    '기존 등록 이름.md',
  );
  pass('원래 등록의 저장 이름을 재입력 없이 승계');

  await reset(
    `${detail}&initialTarget=${encodeURIComponent('../잘못된 이름.md')}`,
    () => control('clearTarget'),
  );
  await expect(
    work().getByRole('textbox', { name: '문서 저장 이름' }),
  ).toBeVisible();
  await expect(action('이 내용으로 등록 계속')).toBeDisabled();
  pass('검증되지 않은 초기 저장 이름은 사용하지 않고 직접 입력 유지');

  await reset(detail, () => control('clearTarget'));
  await expect(
    work().getByRole('textbox', { name: '문서 저장 이름' }),
  ).toBeVisible();
  await editor().fill('목록으로 돌아와도 유지할 편집 내용');
  await page.evaluate(
    (path) => {
      location.hash = path;
    },
    `${detail}&initialTarget=${encodeURIComponent('나중에 확인한 이름.md')}`,
  );
  await expect(
    work().getByRole('textbox', { name: '문서 저장 이름' }),
  ).toHaveCount(0);
  await expect(editor()).toHaveValue('목록으로 돌아와도 유지할 편집 내용');
  await available();
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(
    (await snapshot()).detail.workflow.target_document,
    '나중에 확인한 이름.md',
  );
  pass('같은 workflow에 나중에 도착한 저장 이름 적용 / 편집 초안 유지');

  await reset();
  await available();
  await editor().fill('창 복귀 뒤에도 원래 제출로 복구할 내용');
  await control('lose', 'correct');
  await action('이 내용으로 등록 계속').click();
  await expect(action('저장 결과 확인')).toBeVisible();
  await page.evaluate((path) => {
    location.hash = path;
  }, `${detail}&equivalentScope=1`);
  await recover();
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(new Set((await snapshot()).requests.correct).size, 1);
  pass('동일 접근 범위의 객체가 갱신돼도 최초 제출 요청으로 복구');

  await reset(detail, () => control('missingText'));
  await available();
  await action('이 내용으로 등록 계속').click();
  await expect(
    work().getByText(/2페이지의 내용을 입력하거나 실제로 빈 페이지인지 확인/),
  ).toBeVisible();
  assert.equal((await snapshot()).calls.correct ?? 0, 0);
  await editor().fill('원본을 대조하여 직접 작성한 누락 내용');
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(
    (await snapshot()).detail.corrections[0].content,
    '원본을 대조하여 직접 작성한 누락 내용',
  );
  pass('보관 문자가 없는 페이지는 입력 없이 진행 차단 / 직접 입력 후 등록');

  await reset(detail, () => control('missingText'));
  await available();
  await work()
    .getByRole('checkbox', { name: '원본에서 빈 페이지입니다' })
    .check();
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal((await snapshot()).detail.corrections[0].method, 'blank');
  assert.equal((await snapshot()).detail.corrections[0].content, '');
  pass('실제 빈 페이지 명시 확인을 빈 문자열 보정으로 등록');

  await reset(detail, () => control('generalUnit'));
  await available();
  await work()
    .getByRole('textbox', { name: '1문단 등록할 내용' })
    .fill('수정한 일반 문단');
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(
    (await snapshot()).detail.corrections[0].unit_id,
    'paragraph-one',
  );
  pass('PDF 이외 문단은 원래 unit_id로 수정·등록');

  await reset(detail, () => control('partialWholeDocument'));
  const partialEditor = work().getByRole('textbox', {
    name: '문서 전체 등록할 내용',
  });
  await expect(partialEditor).toHaveValue(
    '첫 슬라이드에 보관한 본문\n\n둘째 슬라이드에 보관한 본문',
  );
  await action('문서 전체').click();
  await page.getByRole('combobox', { name: '탐색 범위' }).selectOption('all');
  await page.getByRole('spinbutton', { name: '이동할 위치' }).fill('1');
  await action('이동').click();
  await expect(
    work().getByRole('textbox', { name: '1슬라이드 등록할 내용' }),
  ).toHaveAttribute('readonly', '');
  await expect(
    work().getByText(
      '구간별 내용은 참고용입니다. 수정은 문서 전체에서 이어가세요.',
    ),
  ).toBeVisible();
  await action('1슬라이드').click();
  await page
    .getByRole('combobox', { name: '탐색 범위' })
    .selectOption('review');
  await page.keyboard.press('Escape');
  await expect(
    work()
      .getByRole('status')
      .filter({ hasText: '그림의 내용을 문자로 읽지 못했습니다' }),
  ).toBeVisible();
  await action('이 내용으로 등록 계속').click();
  assert.equal((await snapshot()).calls.approve ?? 0, 0);
  await expect(work().getByText(/문서 전체의 내용을 입력하거나/)).toBeVisible();
  await partialEditor.fill(
    '첫 슬라이드에 보관한 본문\n\n둘째 슬라이드에 보관한 본문\n그림에서 확인한 보완 설명',
  );
  await action('이 내용으로 등록 계속').click();
  await continued();
  pass(
    '문서 전체 경고에도 보관된 부분 본문 표시 / 누락 경고 유지 / 수동 보완 전 확정 금지',
  );

  await reset(detail, async () => {
    await control('partialWholeDocument');
    await control('legacyUnitDraft', false);
  });
  await expect(partialEditor).toHaveValue(
    '사용자가 보완한 첫 슬라이드\n\n둘째 슬라이드에 보관한 본문',
  );
  await partialEditor.fill(`${await partialEditor.inputValue()}\n그림 보완`);
  await action('이 내용으로 등록 계속').click();
  await continued();
  let saved = (await snapshot()).detail.corrections;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].whole_document, true);
  assert.match(saved[0].content, /사용자가 보완한 첫 슬라이드/);
  pass('이전 구간 초안을 전체 입력에 합친 뒤 단일 전체 보정으로 저장');

  await reset(detail, async () => {
    await control('partialWholeDocument');
    await control('legacyUnitDraft', true);
  });
  await expect(partialEditor).toHaveValue('이전에 작성한 전체 초안');
  await expect(action('이 내용으로 등록 계속')).toBeDisabled();
  await expect(
    work().getByText(/전체와 개별 구간의 초안이 함께/),
  ).toBeVisible();
  await partialEditor.fill(
    '이전에 작성한 전체 초안\n사용자가 보완한 첫 슬라이드',
  );
  await action('문서 전체').click();
  await page.getByRole('spinbutton', { name: '이동할 위치' }).fill('1');
  await action('이동').click();
  await expect(
    work().getByRole('textbox', { name: '1슬라이드 등록할 내용' }),
  ).toHaveValue('사용자가 보완한 첫 슬라이드');
  await action('이 구간의 초안 취소').click();
  await action('이 내용으로 등록 계속').click();
  await continued();
  saved = (await snapshot()).detail.corrections;
  assert.equal(saved.length, 1);
  assert.match(saved[0].content, /사용자가 보완한 첫 슬라이드/);
  pass('이전 전체·구간 초안 공존은 모두 복원하고 명시 정리 전 저장 차단');

  await reset(detail, () => control('partialWholeDocument'));
  await partialEditor.fill('이미 제출한 전체 내용');
  await control('fail', 'correct');
  await action('이 내용으로 등록 계속').click();
  await expect(action('저장 결과 확인')).toBeVisible();
  await control('addUnitToSavedDraft');
  await open(detail);
  await expect(
    work().getByText(/이전에 제출한 문서 전체 내용으로/),
  ).toBeVisible();
  await action('문서 전체').click();
  await page.getByRole('spinbutton', { name: '이동할 위치' }).fill('1');
  await action('이동').click();
  await expect(action('이 구간의 초안 취소')).toBeDisabled();
  await expect(
    work().getByRole('textbox', { name: '1슬라이드 등록할 내용' }),
  ).toHaveValue('고정 제출과 별도로 남은 구간 초안');
  await action('제출한 전체 내용으로 등록 계속').click();
  await continued();
  const fixedState = await snapshot();
  assert.equal(new Set(fixedState.requests.correct).size, 1);
  assert.equal(
    fixedState.detail.corrections[0].content,
    '이미 제출한 전체 내용',
  );
  assert.equal(
    Object.values(fixedState.drafts)[0].data.draft.contents['unit:slide-one'],
    '고정 제출과 별도로 남은 구간 초안',
  );
  await control('complete');
  await open(detail);
  await expect(
    work().getByText(/등록이 완료되었습니다. 이전에 제출하지 않은/),
  ).toBeVisible();
  await expect(action('제출한 전체 내용으로 등록 계속')).toHaveCount(0);
  assert.equal((await snapshot()).calls.continue, fixedState.calls.continue);
  pass(
    '고정 제출은 구간 취소 차단 / 최초 요청으로 재개 / 별도 구간 초안 완료 뒤 보존',
  );

  await reset(detail, async () => {
    await control('partialWholeDocument');
    await control('laterAnalysisFailed');
  });
  await expect(work().getByText(/구체적인 실패 원인이 없습니다/)).toBeVisible();
  await expect(
    work().getByText(/그림의 내용을 문자로 읽지 못했습니다/),
  ).toHaveCount(0);
  pass('후속 분석 실패를 지난 변환 경고로 오인하지 않음');

  await reset(detail, () => control('conversionFailed'));
  await expect(work().getByText(/메모리 또는 실행 자원이 부족/)).toBeVisible();
  await expect(
    work().getByText('등록할 내용을 불러오고 있습니다…'),
  ).toHaveCount(0);
  await expect(work().getByText(/표시할 변환 내용이 없습니다/)).toBeVisible();
  await expect(action('이 내용으로 등록 계속')).toHaveCount(0);
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  pass(
    '변환 보고 없는 실패는 실제 원인과 빈 상태 표시 / 무한 로딩·무근거 재실행 없음',
  );

  await reset(detail, () => control('wholeDocument'));
  await available();
  await work()
    .getByRole('textbox', { name: '문서 전체 등록할 내용' })
    .fill('위치를 판별할 수 없어 원본 전체를 직접 작성한 내용');
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal((await snapshot()).detail.corrections[0].whole_document, true);
  pass('위치 불명 실패는 문서 전체 입력 후 등록');

  await reset(detail, () => control('wholeDocument', 170));
  await available();
  const wholeEditor = work().getByRole('textbox', {
    name: '문서 전체 등록할 내용',
  });
  const firstOriginal = work().getByRole('img', {
    name: '등록한 PDF의 1페이지 원본',
  });
  await expect(firstOriginal).toBeVisible();
  const firstSource = await firstOriginal.getAttribute('src');
  await wholeEditor.fill('원본 여러 페이지를 대조하며 작성하는 전체 문서 초안');
  await action('원본 1 / 170페이지').click();
  await page.getByRole('spinbutton', { name: '이동할 위치' }).fill('100.5');
  await expect(action('이동')).toBeDisabled();
  await page.getByRole('spinbutton', { name: '이동할 위치' }).fill('100');
  await action('이동').click();
  const original100 = work().getByRole('img', {
    name: '등록한 PDF의 100페이지 원본',
  });
  await expect(original100).toBeVisible();
  assert.notEqual(await original100.getAttribute('src'), firstSource);
  await expect(wholeEditor).toHaveValue(
    '원본 여러 페이지를 대조하며 작성하는 전체 문서 초안',
  );
  await action('다음 확인 페이지').click();
  await expect(
    work().getByRole('img', { name: '등록한 PDF의 101페이지 원본' }),
  ).toBeVisible();
  await action('이전 확인 페이지').click();
  await expect(original100).toBeVisible();
  await expect(wholeEditor).toHaveValue(
    '원본 여러 페이지를 대조하며 작성하는 전체 문서 초안',
  );
  await expect(
    work().getByText('이 기기에 초안 저장됨', { exact: true }),
  ).toBeVisible();
  state = await snapshot();
  assert.equal(state.calls.correct ?? 0, 0);
  assert.equal(state.calls.decide ?? 0, 0);
  assert.equal(
    Object.values(state.drafts)[0].data.draft.contents.whole_document,
    '원본 여러 페이지를 대조하며 작성하는 전체 문서 초안',
  );
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal((await snapshot()).detail.corrections[0].whole_document, true);
  pass('문서 전체 입력에서 PDF 1→100→101→100페이지 원본 대조 / 전체 초안 유지');

  await reset(detail, () => control('requiredInput'));
  await available();
  const retainedText = await editor().inputValue();
  assert.ok(retainedText.trim());
  assert.equal(
    (await snapshot()).detail.workflow.pages[0].input_required,
    true,
  );
  await action('이 내용으로 등록 계속').click();
  await expect(
    work().getByText(/2페이지의 내용을 입력하거나 실제로 빈 페이지인지 확인/),
  ).toBeVisible();
  state = await snapshot();
  assert.equal(state.calls.correct ?? 0, 0);
  assert.equal(state.calls.decide ?? 0, 0);
  await editor().fill(retainedText);
  await action('이 내용으로 등록 계속').click();
  await continued();
  state = await snapshot();
  assert.equal(state.calls.correct, 1);
  assert.equal(state.detail.corrections[0].method, 'manual');
  assert.equal(state.detail.corrections[0].content, retainedText);
  pass(
    '입력필수 부분은 기존 문자만으로 통과 차단 / 같은 문자 명시입력도 manual 보정',
  );

  await reset();
  await available();
  await editor().fill('앱을 다시 열어 복원할 편집');
  await expect(
    work().getByText('이 기기에 초안 저장됨', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await available();
  await expect(editor()).toHaveValue('앱을 다시 열어 복원할 편집');
  await editor().fill('저장 직전 마지막 편집');
  const protectsPendingInput = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(protectsPendingInput, true);
  await expect(
    work().getByText('이 기기에 초안 저장됨', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await available();
  await expect(editor()).toHaveValue('저장 직전 마지막 편집');
  pass('재시작 초안 복원 / 두 번째 편집 직후 종료 가드');

  await control('draftReadFailure', true);
  await page.reload();
  await expect(work().getByText(/초안을 복원하지 못했습니다/)).toBeVisible();
  await expect(action('이 내용으로 등록 계속')).toBeDisabled();
  await control('draftReadFailure', false);
  await action('상태 다시 확인').click();
  await available();
  await expect(editor()).toHaveValue('저장 직전 마지막 편집');
  pass('보호 초안 읽기 실패 후 같은 화면의 상태 확인으로 재조회·복원');

  await reset();
  await available();
  await control('draftFailure', true);
  await editor().fill('디스크 저장 실패시 화면에 유지할 입력');
  await expect(work().getByText(/초안을 저장하지 못했습니다/)).toBeVisible();
  await action('이 내용으로 등록 계속').click();
  await expect(editor()).toBeEditable();
  await expect(action('상태 다시 확인')).toBeVisible();
  assert.equal((await snapshot()).calls.correct ?? 0, 0);
  await expect(editor()).toHaveValue('디스크 저장 실패시 화면에 유지할 입력');
  await editor().fill('서버 전송 전에 수정한 새 내용');
  await control('draftFailure', false);
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(
    (await snapshot()).detail.corrections[0].content,
    '서버 전송 전에 수정한 새 내용',
  );
  pass(
    '보호 저장 실패는 서버 변경 차단 / 미전송 입력 편집 재개 후 새 내용 등록',
  );

  await reset();
  await available();
  await editor().fill('보정 응답 유실 후 앱 재시작');
  await control('lose', 'correct');
  await action('이 내용으로 등록 계속').click();
  await expect(action('저장 결과 확인')).toBeVisible();
  await page.reload();
  await available();
  await action('이 내용으로 등록 계속').click();
  await continued();
  assert.equal(new Set((await snapshot()).requests.correct).size, 1);
  pass('서버 보정 성공·응답 유실 뒤 재시작시 최초 요청 복원');

  await reset(detail, () => control('ready', false));
  await expect(action('이 내용으로 등록 계속')).toBeDisabled();
  await expect(
    work().getByRole('link', { name: 'AI 연결 설정' }),
  ).toBeVisible();
  await control('ready', true);
  await refreshed();
  await available();
  pass('환경 미준비는 기존 설정으로 안내 / 상태 확인으로 복귀');

  await reset(detail, () => control('otherPc'));
  await expect(action('이 내용으로 등록 계속')).toHaveCount(0);
  assert.equal((await snapshot()).calls.continue ?? 0, 0);
  pass('진행 중 문서 열람은 새 실행을 만들지 않음');

  await reset();
  await available();
  await editor().fill('접근 회수 전 초안');
  await control('deny');
  await action('상태 다시 확인').click();
  await expect(work().getByRole('textbox')).toHaveCount(0);
  pass('접근 거부 시 원문·초안 표시 제거');
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(destination, 'result.json'),
    JSON.stringify({ checks, errors, screenshots }, null, 2),
  );
  console.log(`PASS ${checks.length} checks; ${destination}`);
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
