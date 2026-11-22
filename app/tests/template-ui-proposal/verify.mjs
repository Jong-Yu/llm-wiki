import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5192/template-ui-proposal/';
const out = 'test-results/template-ui-proposal-20261114';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const checks = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};

try {
  await page.goto(url);
  const question = await page.getByLabel('질문', { exact: true }).inputValue();
  await page.getByRole('button', { name: '템플릿 선택', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '템플릿 선택', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '템플릿 선택', exact: true }).click();
  await page.screenshot({ path: `${out}/proposal-picker.png`, fullPage: true });
  await page
    .getByRole('button', { name: /새 템플릿 등록|등록 중인 템플릿 이어쓰기/ })
    .click();
  await page
    .getByRole('button', { name: '내 템플릿에 저장하고 선택', exact: true })
    .click();
  await expect(
    page.getByText('템플릿 이름을 입력해 주세요.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('양식을 직접 작성하거나 파일에서 가져와 주세요.', {
      exact: true,
    }),
  ).toBeVisible();
  record('선택 팝오버 Escape/초점 복귀와 빈 등록 입력 오류');

  await page
    .getByRole('button', { name: '예시 양식 불러오기', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '이름', exact: false })
    .fill('Nori 상세 템플릿');
  await page
    .getByRole('button', { name: '대화로 돌아가기', exact: true })
    .click();
  await expect(page.getByLabel('질문', { exact: true })).toHaveValue(question);
  await page.getByRole('button', { name: '템플릿 선택', exact: true }).click();
  await page
    .getByRole('button', { name: /새 템플릿 등록|등록 중인 템플릿 이어쓰기/ })
    .click();
  await expect(
    page.getByRole('textbox', { name: '이름', exact: false }),
  ).toHaveValue('Nori 상세 템플릿');
  const before = await page
    .getByRole('textbox', { name: '양식 본문', exact: false })
    .inputValue();
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'unsupported.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('example'),
    });
  await expect(page.getByRole('alert')).toContainText('.md');
  await expect(
    page.getByRole('textbox', { name: '양식 본문', exact: false }),
  ).toHaveValue(before);
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'example.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(before),
    });
  await expect(
    page.getByRole('textbox', { name: '양식 본문', exact: false }),
  ).toHaveValue(before);
  await page.screenshot({
    path: `${out}/proposal-register.png`,
    fullPage: true,
  });
  await page
    .getByRole('button', { name: '내 템플릿에 저장하고 선택', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Nori 상세 템플릿', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('질문', { exact: true })).toHaveValue(question);
  record(
    '등록 왕복의 질문·초안 보존, 파일 형식 오류 보존, Markdown 읽기, 저장 후 선택',
  );

  await page.getByText('이번 요청 규칙', { exact: true }).click();
  await page
    .getByRole('textbox', { name: '이번 결과에만 추가할 규칙' })
    .fill('모바일의 예외 상태를 구분한다.');
  await page
    .getByRole('button', { name: '내용 보기·편집', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: '규칙 3', exact: true }),
  ).toHaveValue('잠긴 문서도 검토자는 수정할 수 있다.');
  await page
    .getByRole('button', { name: '대화로 돌아가기', exact: true })
    .click();
  await page.getByRole('button', { name: '작성', exact: true }).click();
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  await page.getByRole('button', { name: '답변 반영', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Nori 문서 상세 화면 설계서',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel('변경안으로 작성', { exact: false }).check();
  await page.getByRole('button', { name: '답변 반영', exact: true }).click();
  await expect(page.locator('input[name=policy]')).toHaveCount(0);
  await expect(page.locator('input[name=width]')).toHaveCount(3);
  await page.screenshot({
    path: `${out}/proposal-questions-partial.png`,
    fullPage: true,
  });
  await page.getByLabel('640px', { exact: true }).check();
  await page.getByRole('button', { name: '답변 반영', exact: true }).click();
  await expect(
    page.getByText('변경안: 검토자에게만 허용', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('잠긴 문서는 HTTP 423 반환', { exact: true }),
  ).toBeVisible();
  record(
    '일회성 규칙 분리, 질문 기본 확정 없음, 비답변 대기, 부분 답변 보존, 변경안·현행 동작 병기',
  );

  await page
    .getByRole('button', { name: '검사 상세 보기', exact: true })
    .click();
  await page
    .getByRole('button', { name: '검사만 다시 실행', exact: true })
    .click();
  await expect(
    page.getByText('내용 1개 확인 필요', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${out}/proposal-result.png`, fullPage: true });
  await page
    .getByRole('button', { name: '수정하고 다시 검사', exact: true })
    .click();
  await expect(
    page.getByText('내용 자동 검사 통과', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('원문 대조 검사 불가 1개', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '답변 변경', exact: true }).click();
  await expect(
    page.getByLabel('변경안으로 작성', { exact: false }),
  ).toBeChecked();
  await expect(page.getByLabel('640px', { exact: true })).toBeChecked();
  await expect(page.getByText(/변경 전 기준으로 검사됨/)).toBeVisible();
  await page.getByLabel('960px', { exact: true }).check();
  await page.getByRole('button', { name: '답변 반영', exact: true }).click();
  await expect(
    page.getByText('상세 영역 960px', { exact: true }).first(),
  ).toBeVisible();
  record(
    '재검사와 본문 수정 구별, 검사 불가 유지, 답변 변경 시 기존 값·이전 결과 보존',
  );

  for (const width of [1024, 736, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `${out}/proposal-result-${width}.png`,
      fullPage: true,
    });
    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    assert.ok(
      dimensions.scroll <= dimensions.client + 1,
      `${width}px 화면 넘침: ${JSON.stringify(dimensions)}`,
    );
  }
  record('1024·736·390·320px 결과 재배치, 문서 전체 가로 넘침 없음');

  await page.goto(`${url}?view=questions`);
  await page.getByLabel('아직 미정', { exact: false }).check();
  await page.getByLabel('640px', { exact: true }).check();
  await page.getByRole('button', { name: '답변 반영', exact: true }).click();
  await expect(page.getByText(/권한 정책이 아직 미정입니다/)).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Nori 문서 상세 화면 설계서',
      exact: true,
    }),
  ).toHaveCount(0);
  record('필수 정책 미정이면 생성 대기');

  await page.goto(`${url}?view=register`);
  await page
    .getByRole('button', { name: '예시 양식 불러오기', exact: true })
    .click();
  await page.screenshot({
    path: `${out}/proposal-register-320.png`,
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: `${out}/proposal-register-dark.png`,
    fullPage: true,
  });
  record('320px 등록 폼 재배치와 다크 화면 캡처');
  assert.deepEqual(errors, []);
  record('화면 런타임 오류 없음');
  await writeFile(
    `${out}/verification.json`,
    JSON.stringify(
      {
        status: 'passed',
        checks,
        errors,
        note: '예시 UI 상태 전이만 확인. 실제 AI·서버 저장·자유 답변 해석은 실행하지 않음.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
