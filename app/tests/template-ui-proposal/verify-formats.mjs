import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const out = 'test-results/template-ui-formats-20261114';
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
  await page.goto(pathToFileURL(resolve(`${out}/inline-preview.html`)).href);
  const frame = page.frameLocator('iframe');
  const gallery = frame.locator('[data-variant="템플릿 보관함"]');
  async function screenshot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await gallery.evaluate(async (node) => {
      node.ownerDocument.defaultView.scrollTo(0, 0);
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
    await page.screenshot({ path: `${out}/${name}.png` });
  }
  await expect(gallery).toBeVisible();
  await expect(
    gallery.getByText('예시 미리보기', { exact: true }),
  ).toBeVisible();
  await expect(
    gallery.getByRole('button', { name: '✓ 화면명', exact: true }),
  ).toBeVisible();
  await screenshot('gallery-slides');
  await gallery.getByRole('button', { name: /^기능 명세서 DOCX/ }).click();
  await expect(
    gallery.getByText('LOGO · 문서 머리말', { exact: true }),
  ).toBeVisible();
  await gallery.getByRole('button', { name: /^검토 체크리스트 XLSX/ }).click();
  await expect(gallery.getByText('=SUM(D2:D4)')).toBeVisible();
  checks.push('PPTX·DOCX·XLSX 원본 계열별 미리보기');
  await gallery
    .getByRole('button', { name: '새 템플릿 등록', exact: true })
    .click();
  await expect(gallery.getByLabel('템플릿 원본 파일')).not.toHaveAttribute(
    'accept',
  );
  await gallery
    .getByRole('combobox', { name: '결과 파일 형식', exact: true })
    .selectOption('DOCX');
  await expect(
    gallery.getByRole('combobox', { name: '양식 사용 방식', exact: true }),
  ).toHaveValue('structure');
  await expect(gallery.locator('option[value="fill"]')).toBeDisabled();
  await expect(
    gallery.getByText('다른 형식으로 재구성 · 배치는 확인 필요', {
      exact: true,
    }),
  ).toBeVisible();
  checks.push('입력·출력 형식 분리와 다른 형식 선택 시 원본 유지 해제');
  await gallery
    .getByRole('button', { name: 'PDF · 이미지', exact: true })
    .click();
  await expect(gallery.locator('option[value="fill"]')).toBeDisabled();
  await expect(
    gallery.getByRole('combobox', { name: '양식 사용 방식', exact: true }),
  ).toHaveValue('reference');
  checks.push('PDF·이미지 참고 양식과 확인 전 원본 채우기 비활성');
  await gallery
    .getByRole('button', { name: 'PowerPoint', exact: true })
    .click();
  await screenshot('registration-slides');
  for (const width of [768, 352]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['PowerPoint', 'Word · 한글', 'Excel', 'PDF · 이미지']) {
      await gallery.getByRole('button', { name, exact: true }).click();
      const dimensions = await frame.locator('body').evaluate((body) => ({
        viewport: body.ownerDocument.documentElement.clientWidth,
        width: body.ownerDocument.documentElement.scrollWidth,
      }));
      assert.ok(
        dimensions.width <= dimensions.viewport + 1,
        `${name}: ${JSON.stringify(dimensions)}`,
      );
    }
  }
  await gallery.getByRole('button', { name: 'Excel', exact: true }).click();
  await screenshot('registration-sheet-320');
  checks.push('736·320px에서 네 가지 미리보기와 등록 폼 가로 넘침 없음');
  await page.setViewportSize({ width: 1056, height: 900 });
  await gallery.getByRole('button', { name: '직접 정의', exact: true }).click();
  await gallery
    .getByRole('textbox', { name: '이름', exact: true })
    .fill('자연어 양식');
  await gallery
    .getByRole('textbox', { name: '양식 직접 정의', exact: true })
    .fill('화면 그림 옆에 동작 설명 표를 배치해 주세요.');
  await gallery
    .getByRole('button', { name: '개인 템플릿 저장', exact: true })
    .click();
  await expect(
    gallery.getByRole('heading', { name: '자연어 양식', exact: true }),
  ).toBeVisible();
  checks.push('Markdown 제목 없이 자연어 직접 정의 등록');
  await gallery
    .getByRole('button', { name: '새 템플릿 등록', exact: true })
    .click();
  await gallery
    .getByRole('textbox', { name: '이름', exact: true })
    .fill('기타 원본');
  await gallery.getByLabel('템플릿 원본 파일').setInputFiles({
    name: '양식.custom',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('mock'),
  });
  await expect(gallery.getByText('양식.custom', { exact: true })).toBeVisible();
  await gallery
    .getByRole('button', { name: '개인 템플릿 저장', exact: true })
    .click();
  await expect(
    gallery.getByRole('button', { name: '이 템플릿으로 작성', exact: true }),
  ).toBeDisabled();
  checks.push('알 수 없는 형식도 확인 필요로 등록하고 생성은 대기');
  await gallery.getByRole('button', { name: '편집', exact: true }).click();
  await gallery.getByLabel('템플릿 원본 파일').setInputFiles({
    name: '양식.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('mock'),
  });
  await gallery
    .getByRole('button', { name: '개인 템플릿 저장', exact: true })
    .click();
  await expect(
    gallery.getByRole('button', { name: '이 템플릿으로 작성', exact: true }),
  ).toBeDisabled();
  checks.push(
    '선택한 MD 파일도 미해석 상태로 등록하며 직접 정의 본문을 요구하지 않음',
  );
  await gallery.getByRole('button', { name: '편집', exact: true }).click();
  await gallery
    .getByRole('button', { name: '링크로 가져오기', exact: true })
    .click();
  await gallery
    .getByRole('textbox', { name: '템플릿 링크', exact: true })
    .fill('javascript:alert(1)');
  await gallery.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(
    gallery.getByText(
      'http:// 또는 https://로 시작하는 올바른 링크를 입력해 주세요.',
      { exact: true },
    ),
  ).toBeVisible();
  await gallery
    .getByRole('textbox', { name: '템플릿 링크', exact: true })
    .fill('https://example.com/template');
  await gallery.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(
    gallery.getByText('https://example.com/template', { exact: true }),
  ).toBeVisible();
  checks.push('링크 형식 검사와 내용·권한 미확인 상태 표시');
  await page.emulateMedia({ colorScheme: 'dark' });
  await screenshot('registration-dark');
  const duplicates = await frame.locator('body').evaluate((body) => {
    const ids = [...body.querySelectorAll('[id]')].map((node) => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(requests, []);
  checks.push('런타임 오류·중복 ID·fetch/XHR 요청 없음');
  const result = { passed: true, checks, errors, duplicates, requests };
  await writeFile(`${out}/verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
