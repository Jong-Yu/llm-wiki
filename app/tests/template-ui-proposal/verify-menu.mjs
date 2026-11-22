import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const out = 'test-results/template-menu-20261115';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
const requests = [];
const checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1056, height: 920 },
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType()))
      requests.push(request.url());
  });
  const url = (name) =>
    pathToFileURL(resolve(`${out}/template-menu-${name}.html`)).href;
  await page.goto(url('library'));
  const frame = page.frameLocator('iframe');
  const nav = frame.getByRole('navigation', { name: '기본 메뉴', exact: true });
  const library = frame.getByRole('region', {
    name: '템플릿 등록 및 관리',
    exact: true,
  });
  const chat = frame.getByRole('region', { name: 'AI 채팅 화면', exact: true });
  const compose = frame.getByRole('region', {
    name: '산출물 작성 화면',
    exact: true,
  });
  async function shot(name) {
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
    nav.getByRole('link', { name: '템플릿', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    nav.getByRole('link', { name: 'AI 채팅', exact: true }),
  ).not.toHaveAttribute('aria-current');
  await expect(
    library.getByRole('heading', { name: '템플릿 관리', exact: true }),
  ).toBeVisible();
  await shot('library');
  checks.push('독립 템플릿 메뉴 활성화와 관리 화면 진입');
  await nav.getByRole('link', { name: 'AI 채팅', exact: true }).click();
  await expect(chat).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'AI 채팅', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    chat.getByRole('button', { name: '템플릿 관리', exact: true }),
  ).toHaveCount(0);
  await expect(chat.locator('input[type="file"]')).toHaveCount(0);
  await shot('chat');
  await chat
    .getByRole('combobox', { name: '템플릿', exact: true })
    .selectOption('report');
  await chat
    .getByRole('textbox', { name: '질문 또는 작성 요청', exact: true })
    .fill('이번 주 진행 상황을 보고서로 정리해 줘.');
  await nav.getByRole('link', { name: '템플릿', exact: true }).click();
  await library.getByRole('button', { name: /요구사항 점검표 XLSX/ }).click();
  await library.getByRole('button', { name: '편집', exact: true }).click();
  await library
    .getByRole('textbox', { name: '작성 룰', exact: true })
    .fill('미저장 편집 초안');
  await nav.getByRole('link', { name: 'AI 채팅', exact: true }).click();
  await expect(
    chat.getByRole('combobox', { name: '템플릿', exact: true }),
  ).toHaveValue('report');
  await expect(
    chat.getByRole('textbox', { name: '질문 또는 작성 요청', exact: true }),
  ).toHaveValue('이번 주 진행 상황을 보고서로 정리해 줘.');
  await nav.getByRole('link', { name: '템플릿', exact: true }).click();
  await expect(
    library.getByRole('textbox', { name: '작성 룰', exact: true }),
  ).toHaveValue('미저장 편집 초안');
  checks.push('관리 탐색과 채팅 선택 분리·각 초안 메뉴 왕복 보존');
  await library
    .getByRole('button', { name: '템플릿 목록으로', exact: true })
    .click();
  await library
    .getByRole('button', { name: '새 템플릿 등록', exact: true })
    .click();
  await library
    .getByRole('textbox', { name: '템플릿 이름', exact: true })
    .fill('공용 화면설계서');
  await library
    .getByRole('button', { name: '예시 양식 사용', exact: true })
    .click();
  await library
    .getByRole('textbox', { name: '작성 룰', exact: true })
    .fill('오류 상태를 포함하세요.');
  await library.getByRole('button', { name: '저장', exact: true }).click();
  await library
    .getByRole('button', { name: '이 템플릿으로 만들기', exact: true })
    .click();
  await expect(compose).toBeVisible();
  await expect(
    compose.getByRole('combobox', { name: '템플릿', exact: true }),
  ).toHaveValue(/custom-/);
  await expect(
    compose.getByRole('button', { name: '템플릿 관리', exact: true }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole('link', { name: 'AI 채팅', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await compose.getByText('적용할 작성 룰 1개 보기', { exact: true }).click();
  await expect(
    compose.getByText('오류 상태를 포함하세요.', { exact: true }),
  ).toBeVisible();
  await compose
    .getByRole('textbox', { name: '무엇을 만들까요?', exact: true })
    .fill('문서 상세 화면을 만들어 줘.');
  await compose
    .getByRole('button', { name: '산출물 만들기', exact: true })
    .click();
  await expect(
    compose.getByRole('heading', { name: '작성 요청 미리보기', exact: true }),
  ).toBeVisible();
  checks.push('독립 관리에서 등록 → 산출물 작성 선택·파일·룰 동시 반영');
  await nav.getByRole('link', { name: 'AI 채팅', exact: true }).click();
  await expect(
    chat.getByRole('combobox', { name: '템플릿', exact: true }),
  ).toHaveValue('report');
  await chat
    .getByRole('button', { name: '산출물 만들기', exact: true })
    .click();
  await expect(
    compose.getByRole('textbox', { name: '무엇을 만들까요?', exact: true }),
  ).toHaveValue('문서 상세 화면을 만들어 줘.');
  await expect(
    compose.getByRole('combobox', { name: '템플릿', exact: true }),
  ).toHaveValue('report');
  checks.push('채팅에서 산출물 작성으로 명시 선택 전달·기존 요청 보존');
  await page.goto(url('compose'));
  await expect(compose).toBeVisible();
  await shot('compose');
  for (const name of ['library', 'chat', 'compose']) {
    await page.goto(url(name));
    for (const width of [768, 352]) {
      await page.setViewportSize({ width, height: 920 });
      const dimensions = await frame.locator('body').evaluate((body) => ({
        viewport: body.ownerDocument.documentElement.clientWidth,
        width: body.ownerDocument.documentElement.scrollWidth,
      }));
      assert.ok(
        dimensions.width <= dimensions.viewport + 1,
        `${name}: ${JSON.stringify(dimensions)}`,
      );
    }
    await shot(`${name}-320`);
    await expect(
      nav.getByRole('link', { name: '템플릿', exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1056, height: 920 });
  }
  checks.push('736·320px 세 화면 가로 넘침 없음·접힌 메뉴에서도 템플릿 접근');
  await page.goto(url('library'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('library-dark');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const result = { passed: true, checks, errors, requests };
  await writeFile(`${out}/verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
