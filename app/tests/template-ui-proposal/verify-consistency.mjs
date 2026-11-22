import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const out = process.argv[2] ?? 'test-results/template-consistency-20261115';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [],
  requests = [],
  checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1056, height: 940 },
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType()))
      requests.push(request.url());
  });
  await page.goto(pathToFileURL(resolve(`${out}/inline-preview.html`)).href);
  const frame = page.frameLocator('iframe');
  const nav = frame.getByRole('navigation', { name: '기본 메뉴', exact: true });
  const library = frame.getByRole('region', {
    name: '템플릿 등록 및 관리',
    exact: true,
  });
  const chat = frame.getByRole('region', { name: 'AI 채팅', exact: true });
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
  await expect(library.getByRole('table')).toBeVisible();
  await expect(
    frame.getByRole('button', { name: '템플릿 등록', exact: true }),
  ).toBeVisible();
  await expect(
    library.getByRole('heading', { name: '템플릿 관리', exact: true }),
  ).toHaveCount(0);
  await shot('templates');
  const search = library.getByRole('textbox', {
    name: '템플릿 검색',
    exact: true,
  });
  await expect(search).toBeVisible();
  await expect(
    library.getByRole('navigation', { name: '템플릿 페이지', exact: true }),
  ).toBeVisible();
  await expect(
    library.getByText('양식 파일과 작성 룰을 함께 보관합니다.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await search.fill('회사');
  await search.press('Enter');
  await expect(library.locator('tbody tr')).toHaveCount(1);
  await search.fill('없는 검색어');
  await search.press('Enter');
  await expect(
    library.getByRole('heading', { name: '검색 결과가 없습니다', exact: true }),
  ).toBeVisible();
  await library
    .getByRole('button', { name: '검색 조건 초기화', exact: true })
    .click();
  await library
    .getByRole('combobox', { name: '템플릿 형식 필터', exact: true })
    .selectOption('DOCX');
  await expect(library.locator('tbody tr')).toHaveCount(1);
  await expect(
    library.getByRole('button', { name: '주간 업무보고', exact: true }),
  ).toBeVisible();
  await library
    .getByRole('combobox', { name: '템플릿 형식 필터', exact: true })
    .selectOption('all');
  await expect(library.locator('tbody tr')).toHaveCount(3);
  const layout = await library.evaluate((node) => {
    const searchInput = node.querySelector('form[role="search"] label');
    const select = node.querySelector('select');
    return {
      gutter: getComputedStyle(node).paddingLeft,
      fontSize: getComputedStyle(node).fontSize,
      searchHeight: searchInput?.getBoundingClientRect().height,
      selectHeight: select?.getBoundingClientRect().height,
      secondaryRows: [...node.querySelectorAll('tbody tr')].every(
        (row) => row.dataset.secondary === 'true',
      ),
    };
  });
  assert.equal(layout.gutter, '16px');
  assert.equal(layout.fontSize, '13px');
  assert.equal(layout.searchHeight, 36);
  assert.equal(layout.selectHeight, 36);
  assert.equal(layout.secondaryRows, true);
  checks.push(
    '기존 문서 목록 검색·필터·페이지 구조, 검색/초기화/형식 선택, 16px 여백·36px 컨트롤·13px 글자 확인',
  );
  await library
    .getByRole('button', { name: '회사 화면설계서', exact: true })
    .click();
  await expect(library.getByRole('table')).toHaveCount(0);
  await expect(
    frame.getByRole('button', { name: 'AI 채팅에서 사용', exact: true }),
  ).toBeVisible();
  await shot('template-detail');
  await frame
    .getByRole('navigation', { name: '현재 위치', exact: true })
    .getByRole('link', { name: '템플릿', exact: true })
    .click();
  await expect(library.getByRole('table')).toBeVisible();
  await library
    .getByRole('button', { name: '회사 화면설계서', exact: true })
    .click();
  await frame.getByRole('button', { name: '편집', exact: true }).click();
  await library
    .getByRole('textbox', {
      name: '작성 룰',
      exact: true,
    })
    .fill('빈 상태를 포함하세요.');
  await shot('template-edit');
  await nav.getByRole('link', { name: 'AI 채팅', exact: true }).click();
  await expect(
    frame.getByRole('button', { name: '저장', exact: true }),
  ).toHaveCount(0);
  await chat
    .getByRole('textbox', { name: '질문', exact: true })
    .fill('Nori 문서 상세 화면을 만들어 줘.');
  await nav.getByRole('link', { name: '템플릿', exact: true }).click();
  await expect(
    library.getByRole('textbox', {
      name: '작성 룰',
      exact: true,
    }),
  ).toHaveValue('빈 상태를 포함하세요.');
  await frame.getByRole('button', { name: '저장', exact: true }).click();
  await frame
    .getByRole('button', { name: 'AI 채팅에서 사용', exact: true })
    .click();
  await expect(
    chat.getByRole('textbox', { name: '질문', exact: true }),
  ).toHaveValue('Nori 문서 상세 화면을 만들어 줘.');
  await expect(
    chat.getByRole('button', { name: '산출물 만들기', exact: true }),
  ).toHaveCount(0);
  await shot('chat');
  checks.push(
    '기존 표/헤더 구조·상세/편집 전환·헤더 행동 격리·메뉴 왕복 초안 보존',
  );
  await chat.getByRole('button', { name: '질문 보내기', exact: true }).click();
  const preview = chat.getByRole('button', { name: /\.pptx 내용 미리 보기$/ });
  await expect(preview).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'AI 채팅', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await shot('chat-result');
  await preview.click();
  const previewId = await preview.getAttribute('aria-controls');
  assert.ok(previewId);
  await expect(
    chat
      .locator(`[id="${previewId}"]`)
      .getByText(
        '선택한 양식을 사용하는 산출물이 이 대화 안에 표시되는 예시입니다.',
        { exact: false },
      ),
  ).toBeVisible();
  await chat.getByText('이 요청에 적용한 템플릿·룰', { exact: true }).click();
  await expect(
    chat.getByText('빈 상태를 포함하세요.', { exact: true }),
  ).toBeVisible();
  await chat.getByRole('button', { name: '내려받기', exact: true }).click();
  await expect(
    chat.getByText(
      'PPTX 파일은 생성되지 않았습니다. 이 시안에서는 내려받을 수 없습니다.',
      { exact: true },
    ),
  ).toBeVisible();
  checks.push(
    'AI 채팅 안에서 요청→PPTX 예시 파일 카드→미리보기·요청 룰 확인, 실제 내려받기 미연결 안내',
  );
  await nav.getByRole('link', { name: '템플릿', exact: true }).click();
  await frame.getByRole('button', { name: '목록', exact: true }).click();
  await frame.getByRole('button', { name: '템플릿 등록', exact: true }).click();
  await shot('template-register');
  await expect(
    library.getByRole('button', { name: '템플릿 등록', exact: true }),
  ).toBeDisabled();
  await expect(
    library.getByRole('button', { name: '취소', exact: true }),
  ).toHaveCount(0);
  await library
    .getByRole('textbox', { name: '템플릿 이름', exact: true })
    .fill('새 화면 양식');
  await library.getByLabel('양식 파일 선택', { exact: true }).setInputFiles({
    name: '검증_양식.pptx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from('Local UI fixture. Only its filename is used.'),
  });
  await library
    .getByRole('textbox', {
      name: '작성 룰',
      exact: true,
    })
    .fill('새 양식의 룰');
  await library
    .getByRole('button', { name: '템플릿 등록', exact: true })
    .click();
  await nav.getByRole('link', { name: 'AI 채팅', exact: true }).click();
  await chat.getByRole('button', { name: '옵션 열기', exact: true }).click();
  await chat.getByRole('menuitem', { name: /답변 양식/ }).click();
  await chat.getByRole('menuitemradio', { name: /새 화면 양식/ }).click();
  await expect(
    chat.getByText('양식: 새 화면 양식', { exact: true }),
  ).toBeVisible();
  await expect(
    chat.getByText('빈 상태를 포함하세요.', { exact: true }),
  ).toBeVisible();
  checks.push('새 등록 양식이 기존 ＋ 메뉴에 반영·기존 요청 룰 스냅샷 유지');
  await chat.getByRole('button', { name: '옵션 열기', exact: true }).click();
  await chat.getByRole('menuitem', { name: /답변 양식/ }).click();
  await chat.getByRole('menuitemradio', { name: /기본 답변/ }).click();
  await chat
    .getByRole('textbox', { name: '질문', exact: true })
    .fill('일반 질문입니다.');
  await chat.getByRole('textbox', { name: '질문', exact: true }).press('Enter');
  await expect(
    chat.getByText('시안의 고정 응답 예시입니다.', { exact: false }),
  ).toBeVisible();
  await chat
    .getByRole('button', { name: '대화 목록 열기', exact: true })
    .click();
  await expect(
    chat.getByRole('button', { name: '새 대화', exact: true }),
  ).toBeVisible();
  checks.push('기본 답변·Enter 전송·기존 대화 목록 유지');
  for (const width of [768, 352]) {
    await page.setViewportSize({ width, height: 940 });
    const dimensions = await frame.locator('body').evaluate((body) => ({
      viewport: body.ownerDocument.documentElement.clientWidth,
      width: body.ownerDocument.documentElement.scrollWidth,
    }));
    assert.ok(
      dimensions.width <= dimensions.viewport + 1,
      JSON.stringify(dimensions),
    );
  }
  await nav.getByRole('link', { name: '템플릿', exact: true }).click();
  await frame
    .getByRole('navigation', { name: '현재 위치', exact: true })
    .getByRole('link', { name: '템플릿', exact: true })
    .click();
  await expect(library.getByRole('table')).toBeVisible();
  await expect(library.locator('td[data-label="양식"]').first()).toBeVisible();
  await expect(
    library.locator('td[data-label="작성 룰"]').first(),
  ).toBeVisible();
  const narrow = await frame.locator('body').evaluate((body) => ({
    viewport: body.ownerDocument.documentElement.clientWidth,
    width: body.ownerDocument.documentElement.scrollWidth,
  }));
  assert.ok(narrow.width <= narrow.viewport + 1, JSON.stringify(narrow));
  const contentBounds = await frame
    .locator('[data-workspace-container]')
    .evaluate((node) => ({
      height: node.clientHeight,
      contentHeight: node.scrollHeight,
    }));
  assert.ok(
    contentBounds.contentHeight <= contentBounds.height + 1,
    JSON.stringify(contentBounds),
  );
  await shot('templates-320');
  checks.push('736·320px 채팅/대화 목록,320px 템플릿 화면 가로 넘침 없음');
  await page.setViewportSize({ width: 1056, height: 940 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const theme = await frame
    .locator('.wiki-theme')
    .getAttribute('data-wiki-theme');
  if (process.argv[3]) assert.equal(theme, process.argv[3]);
  await shot(
    theme === 'cream' ? 'template-cream-system-dark' : 'template-dark',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const result = { passed: true, checks, layout, theme, errors, requests };
  await writeFile(`${out}/verification.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
