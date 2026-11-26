import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { chromium, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../../test-results/document-workflow-proposal');
const destination = process.argv[3] ?? resolve(output, 'verification');
await mkdir(destination, { recursive: true });
const base = pathToFileURL(
  process.argv[2] ?? resolve(output, 'preview.html'),
).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [],
  requests = [],
  checks = [],
  screenshots = [];
let scene = 0;
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
const pass = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const route = async (hash, mode = 'after') => {
  await page.goto(`${base}?mode=${mode}&scene=${++scene}#${hash}`);
  await expect(
    page.getByRole('navigation', { name: '기본 메뉴' }),
  ).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: '시안 비교 도구' }),
  ).toBeVisible();
};
const screenshot = async (name) => {
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: resolve(destination, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
  screenshots.push(`${name}.png`);
};
const count = () =>
  page.evaluate(() => window.__workflowPreview.previewActionCount());
const row = (id) => page.locator(`[data-task-id="${id}"]`);
const main = () => page.getByRole('main');
const noOverflow = async () =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
try {
  await route('/sessions', 'before');
  await expect(
    page.getByText('돌고 있는 작업이 없습니다', { exact: true }),
  ).toBeVisible();
  await screenshot('before-tasks-1280');
  await route(
    '/register?sourceId=' + 'b'.repeat(32) + '&version=' + 'c'.repeat(32),
    'before',
  );
  await expect(
    page.getByText('본문을 변환하지 못했습니다', { exact: true }),
  ).toBeVisible();
  await screenshot('before-failure-1280');
  await route('/documents', 'before');
  await expect(
    page.getByRole('button', { name: '아키텍처 검토 자료', exact: true }),
  ).toBeVisible();
  await screenshot('before-documents-1280');
  pass('현재 제품 AppShell·등록 진행·문서 목록의 동일 합성 자료 기준 화면');

  await route('/tasks');
  await expect(row('architecture')).toBeVisible();
  await expect(page.locator('[data-task-id]')).toHaveCount(6);
  await screenshot('after-tasks-1280');
  await page.getByRole('button', { name: /^조치 필요/ }).click();
  await expect(page.locator('[data-task-id]')).toHaveCount(3);
  await page.getByLabel('문서 이름 검색', { exact: true }).fill('아키텍처');
  await expect(page.locator('[data-task-id]')).toHaveCount(1);
  const listHash = new URL(page.url()).hash;
  await row('architecture')
    .getByRole('link', { name: '아키텍처 검토 자료', exact: true })
    .click();
  await expect(
    page.getByText(/구체적인 중단 원인이 기록되지 않았습니다/),
  ).toBeVisible();
  assert.equal(await count(), 0);
  await screenshot('after-failure-1280');
  await page.getByRole('button', { name: '뒤로가기', exact: true }).click();
  assert.equal(new URL(page.url()).hash, listHash);
  await expect(row('architecture')).toBeVisible();
  assert.equal(await count(), 0);
  pass('열람만으로 실패 해소·재실행 없음; 검색·필터를 유지해 출발 목록 복귀');

  await row('architecture')
    .getByRole('link', { name: '아키텍처 검토 자료', exact: true })
    .click();
  const detailHash = new URL(page.url()).hash;
  await page.getByRole('button', { name: '다시 변환', exact: true }).click();
  assert.equal(new URL(page.url()).hash, detailHash);
  await expect(main().getByText('문자 변환 중', { exact: true })).toBeVisible();
  assert.equal(await count(), 1);
  assert.equal(
    await page.evaluate(
      () =>
        window.__workflowPreview
          .readTasks()
          .find((task) => task.id === 'architecture').attempt,
    ),
    3,
  );
  pass('같은 작업에서 원본 재등록 없이 처음부터 재변환하는 모의 행동');

  await route('/documents');
  await expect(
    main().getByText('문자 변환 실패', { exact: true }),
  ).toBeVisible();
  await expect(
    main().getByText('문서 저장됨 · 관계 추출 중단', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('이전 성공 결과 보존 · 최신 시도 확인 필요', {
      exact: true,
    }),
  ).toBeVisible();
  await screenshot('after-documents-1280');
  const documentRow = page.getByRole('row').filter({
    has: page.getByRole('button', {
      name: '아키텍처 검토 자료',
      exact: true,
    }),
  });
  await documentRow
    .getByRole('link', { name: '작업 보기', exact: true })
    .click();
  assert.equal(new URL(page.url()).hash, '#/tasks?task=architecture');
  assert.equal(await count(), 0);
  await page.getByRole('button', { name: '뒤로가기', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#/documents');
  pass('실제 문서 목록에서 구체 상태·이전 성공을 구분하고 동일 상세로 이동');

  await route('/tasks?task=mode');
  await expect(
    page.getByText('문서는 저장됐지만 관계 추출이 끝나지 않았습니다', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    main().getByRole('link', { name: '운전 모드 전환', exact: true }),
  ).toBeVisible();
  await screenshot('after-partial-1280');
  await main()
    .getByRole('link', { name: '운전 모드 전환', exact: true })
    .click();
  await page.getByRole('button', { name: '뒤로가기', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#/tasks?task=mode');
  await page
    .getByRole('button', { name: '실행 조건 확인', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '미완료 단계 실행', exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () =>
        window.__workflowPreview.readTasks().find((task) => task.id === 'mode')
          .state,
    ),
    'partial',
  );
  await page
    .getByRole('button', { name: '미완료 단계 실행', exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        window.__workflowPreview.readTasks().find((task) => task.id === 'mode')
          .state,
    ),
    'running',
  );
  pass('부분 결과 보존; 조건 확인과 미완료 단계 실행을 별도 클릭으로 분리');

  await route('/tasks?task=interface');
  await screenshot('after-unconfirmed-1280');
  await expect(
    page.getByRole('button', { name: '결과 확인', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '다시 변환', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '미완료 단계 실행', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '결과 확인', exact: true }).click();
  assert.equal(
    await page.evaluate(
      () =>
        window.__workflowPreview
          .readTasks()
          .find((task) => task.id === 'interface').state,
    ),
    'ready',
  );
  pass('저장 미확정은 원래 요청의 결과 확인만 제공');

  await route('/tasks?task=safety');
  await expect(
    main().getByText('추출 완료 · 검토 전', { exact: true }).first(),
  ).toBeVisible();
  await screenshot('after-complete-1280');
  await route('/tasks');
  await page.getByRole('link', { name: '문서 등록', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '등록하고 관계 추출', exact: true }),
  ).toBeEnabled();
  await screenshot('registration-existing-form-1280');
  await page
    .getByRole('button', { name: '등록하고 관계 추출', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\?task=registered-/);
  assert.equal(
    await page.evaluate(() => window.__workflowPreview.readTasks().length),
    7,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__workflowPreview
          .readTasks()
          .find((task) => task.id === 'sensor').state,
    ),
    'running',
  );
  pass('기존 등록 폼의 모의 접수→새 작업 상세, 진행 중이던 다른 작업 유지');

  await route('/register');
  await page.getByRole('button', { name: '파일 업로드', exact: true }).click();
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page
    .getByRole('button', { name: '등록하고 관계 추출', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\?task=registered-/);
  assert.equal(
    await page.evaluate(() => window.__workflowPreview.readTasks()[0].fileName),
    '모의-샘플-문서.pdf',
  );
  assert.equal(
    await page.evaluate(() => window.__workflowPreview.readTasks()[0].phase),
    'conversion',
  );
  await page.getByRole('button', { name: '현재 화면', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '현재 화면', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  assert.equal(
    await page.evaluate(() => window.__workflowPreview.readTasks().length),
    7,
  );
  assert.equal(
    await page.evaluate(() => window.__workflowPreview.readTasks()[0].phase),
    'conversion',
  );
  await page.getByRole('button', { name: '개선안', exact: true }).click();
  await expect(page).toHaveURL(/#\/tasks\?task=registered-/);
  pass('모의 PDF 등록의 변환 단계 및 현재/개선안 비교 전환 중 동일 자료 보존');

  await route('/tasks?task=interface');
  await main()
    .getByRole('link', { name: '제어-인터페이스.md', exact: true })
    .click();
  await expect(
    page.getByText('저장 결과 확인 전입니다.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '뒤로가기', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#/tasks?task=interface');
  await route('/tasks?task=safety');
  await main()
    .getByRole('link', { name: '추출 관계 확인 · 검토 전', exact: true })
    .click();
  await page.getByRole('button', { name: '뒤로가기', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#/tasks?task=safety');
  pass('원본·문서·관계에서 동일 작업으로 복귀; 원본에도 저장 미확정 유지');

  await route('/tasks?task=ready');
  const steps = page.getByRole('list', { name: '문서 처리 단계' });
  await expect(steps.getByText('실행 전', { exact: true })).toBeVisible();
  await expect(steps.getByText('진행 중', { exact: true })).toHaveCount(0);
  await route('/tasks?task=sensor');
  await page
    .getByRole('button', { name: '이 기기 실행 중단', exact: true })
    .click();
  await expect(main().getByText('실행 중단됨', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '다시 변환', exact: true }),
  ).toBeVisible();
  pass('실행 전·로컬 중단을 진행 중과 구별하고 상태별 행동 제공');

  for (const width of [720, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await route('/tasks?task=architecture');
    await noOverflow();
    await screenshot(`after-failure-${width}`);
    await route('/tasks');
    await noOverflow();
    assert.equal(
      await page.getByRole('contentinfo').evaluate((footer) => {
        const bounds = footer.getBoundingClientRect();
        return [...footer.querySelectorAll('a')].every((link) => {
          const rect = link.getBoundingClientRect();
          return (
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.right <= innerWidth
          );
        });
      }),
      true,
      '상태바의 작업·연결 링크가 한 줄 안에 보존됨',
    );
    await screenshot(`after-tasks-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await route('/tasks?task=architecture');
  await page.getByLabel('시안 테마', { exact: true }).selectOption('dark');
  assert.equal(
    await page
      .locator('.preview-frame > .wiki-theme')
      .getAttribute('data-wiki-theme'),
    'dark',
  );
  await screenshot('after-failure-dark-1280');
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement !== document.body),
    true,
  );
  pass('320/720/1280 폭의 가로 넘침 없음, 실제 다크 테마 적용과 키보드 초점');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  pass('브라우저 실행 오류 0 · 외부 HTTP 요청 0');
} catch (error) {
  console.error('UI ERROR', error.message.slice(0, 1600), errors);
  await screenshot('failure');
  throw error;
} finally {
  await writeFile(
    resolve(destination, 'results.json'),
    JSON.stringify(
      {
        checks,
        errors,
        requests,
        screenshots,
        limitation:
          '합성 자료를 사용한 UI 시안 검증. 실제 저장·변환·AI·재시작 복원·Windows 앱 검증 아님.',
      },
      null,
      2,
    ) + '\n',
  );
  await browser.close();
}
