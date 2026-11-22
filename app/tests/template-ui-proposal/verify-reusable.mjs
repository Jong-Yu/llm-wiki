import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const out = 'test-results/template-reuse-20261114';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const checks = [];
const errors = [];
const requests = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1056, height: 900 },
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType()))
      requests.push(request.url());
  });
  const url = (name) => pathToFileURL(resolve(`${out}/${name}.html`)).href;
  await page.goto(url('library'));
  const frame = page.frameLocator('iframe');
  const library = frame.getByRole('region', {
    name: '템플릿 등록 및 관리',
    exact: true,
  });
  const compose = frame.getByRole('region', {
    name: '산출물 작성 화면',
    exact: true,
  });
  async function screenshot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await frame.locator('body').evaluate(async (node) => {
      node.ownerDocument.defaultView.scrollTo(0, 0);
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
    await page.screenshot({ path: `${out}/${name}.png` });
  }
  await expect(
    library.getByRole('heading', { name: '템플릿 관리', exact: true }),
  ).toBeVisible();
  await screenshot('library');
  await library
    .getByRole('button', { name: '새 템플릿 등록', exact: true })
    .click();
  await library.getByRole('button', { name: '저장', exact: true }).click();
  await expect(
    library.getByText('템플릿 이름을 입력해 주세요.', { exact: true }),
  ).toBeVisible();
  await expect(
    library.getByText('양식 파일을 선택해 주세요.', { exact: true }),
  ).toBeVisible();
  checks.push('등록 필수값 오류와 입력 유지');
  await library
    .getByRole('textbox', { name: '템플릿 이름', exact: true })
    .fill('내 화면설계서');
  await library
    .getByRole('button', { name: '예시 양식 사용', exact: true })
    .click();
  await library
    .getByRole('textbox', { name: '작성 룰', exact: true })
    .fill('각 화면에 빈 상태를 포함하세요.\n문서 근거를 적어 주세요.');
  await screenshot('registration');
  await library
    .getByRole('button', { name: '템플릿 목록으로', exact: true })
    .click();
  await library
    .getByRole('button', { name: '새 템플릿 등록', exact: true })
    .click();
  await expect(
    library.getByRole('textbox', { name: '템플릿 이름', exact: true }),
  ).toHaveValue('내 화면설계서');
  await expect(
    library.getByRole('textbox', { name: '작성 룰', exact: true }),
  ).toHaveValue('각 화면에 빈 상태를 포함하세요.\n문서 근거를 적어 주세요.');
  await library.getByRole('button', { name: '저장', exact: true }).click();
  await library
    .getByRole('button', { name: '이 템플릿으로 만들기', exact: true })
    .click();
  await expect(
    compose.getByRole('combobox', { name: '템플릿', exact: true }),
  ).toHaveValue(/custom-/);
  await compose.getByText('적용할 작성 룰 2개 보기', { exact: true }).click();
  await expect(
    compose.getByText('각 화면에 빈 상태를 포함하세요.', { exact: true }),
  ).toBeVisible();
  checks.push('등록 초안 왕복 보존 → 저장 → 양식과 룰 묶음 선택');
  await compose
    .getByRole('textbox', { name: '무엇을 만들까요?', exact: true })
    .fill('문서 상세 화면을 작성해 줘.');
  await compose
    .getByRole('button', { name: '템플릿 관리', exact: true })
    .click();
  await library.getByRole('button', { name: '편집', exact: true }).click();
  await library
    .getByRole('textbox', { name: '작성 룰', exact: true })
    .fill('빈 상태와 오류 상태를 포함하세요.');
  await library.getByRole('button', { name: '저장', exact: true }).click();
  await library
    .getByRole('button', { name: '이 템플릿으로 만들기', exact: true })
    .click();
  await expect(
    compose.getByRole('textbox', { name: '무엇을 만들까요?', exact: true }),
  ).toHaveValue('문서 상세 화면을 작성해 줘.');
  await expect(
    compose.getByText('빈 상태와 오류 상태를 포함하세요.', { exact: true }),
  ).toBeVisible();
  checks.push('관리 왕복에서 요청 초안 보존·저장한 룰 최신값 반영');
  await compose
    .getByRole('button', { name: '산출물 만들기', exact: true })
    .click();
  await expect(
    compose.getByRole('heading', { name: '작성 요청 미리보기', exact: true }),
  ).toBeVisible();
  await compose
    .getByText('요청에 포함된 작성 룰 보기', { exact: true })
    .click();
  await compose
    .getByRole('combobox', { name: '템플릿', exact: true })
    .selectOption('report');
  await expect(
    compose.getByText('이전 요청 기준', { exact: true }),
  ).toBeVisible();
  await expect(
    compose.getByText('빈 상태와 오류 상태를 포함하세요.', { exact: true }),
  ).toBeVisible();
  checks.push('작성 요청의 양식·룰 스냅샷 보존과 현재 선택 구별');
  await page.goto(url('compose'));
  await expect(
    compose.getByRole('combobox', { name: '템플릿', exact: true }),
  ).toHaveValue('screen');
  await screenshot('compose');
  await compose
    .getByRole('combobox', { name: '템플릿', exact: true })
    .selectOption('checklist');
  await expect(
    compose.getByText('요구사항점검표.xlsx', { exact: true }),
  ).toBeVisible();
  await compose
    .getByRole('combobox', { name: '템플릿', exact: true })
    .selectOption('report');
  await expect(
    compose.getByText('주간업무보고.docx', { exact: true }),
  ).toBeVisible();
  checks.push('독립 작성 진입과 PPTX·XLSX·DOCX 선택');
  for (const width of [768, 352]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await frame.locator('body').evaluate((body) => ({
      viewport: body.ownerDocument.documentElement.clientWidth,
      width: body.ownerDocument.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.width <= dimensions.viewport + 1,
      JSON.stringify(dimensions),
    );
  }
  await screenshot('compose-320');
  await compose
    .getByRole('button', { name: '템플릿 관리', exact: true })
    .click();
  await library.getByRole('button', { name: /회사 화면설계서 PPTX/ }).click();
  await expect(
    library.getByRole('button', { name: '이 템플릿으로 만들기', exact: true }),
  ).toBeVisible();
  await library.getByRole('button', { name: '편집', exact: true }).click();
  await expect(library.locator('input[type="file"]')).not.toHaveAttribute(
    'accept',
  );
  await library.locator('input[type="file"]').setInputFiles({
    name: '기존양식.hwpx',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('mock'),
  });
  await expect(
    library.getByText('파일명만 반영 · 내용 확인 미연결', { exact: true }),
  ).toBeVisible();
  // 높이가 바뀌는 좁은 iframe에서 좌표 대신 실제 키보드 저장 동작을 확인합니다.
  await library.getByRole('button', { name: '저장', exact: true }).focus();
  await library
    .getByRole('button', { name: '저장', exact: true })
    .press('Enter');
  await expect(
    library.getByText('기존양식.hwpx', { exact: true }),
  ).toBeVisible();
  await expect(
    library.getByText('내용 확인 필요', { exact: true }),
  ).toBeVisible();
  const narrow = await frame.locator('body').evaluate((body) => ({
    viewport: body.ownerDocument.documentElement.clientWidth,
    width: body.ownerDocument.documentElement.scrollWidth,
  }));
  assert.ok(narrow.width <= narrow.viewport + 1, JSON.stringify(narrow));
  checks.push('736·320px 작성 화면,320px 관리·편집·파일 등록과 확인 필요 표시');
  await page.setViewportSize({ width: 1056, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await screenshot('library-dark');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const result = { passed: true, checks, errors, requests };
  await writeFile(`${out}/verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
