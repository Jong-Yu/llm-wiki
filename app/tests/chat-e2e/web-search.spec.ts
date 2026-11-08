import { createHash } from 'node:crypto';
import { test, expect } from './fixtures';
import {
  answered,
  ask,
  composer,
  conversation,
  newConversation,
  resize,
} from './chat';
import type { Page } from '@playwright/test';

/** 작은 지구본 설정에서 공개 검색어를 확인한 뒤에만 이번 질문에 적용합니다. */
async function includeWeb(page: Page, query: string): Promise<void> {
  await page.getByRole('button', { name: '웹 검색', exact: true }).click();
  await page.getByRole('textbox', { name: '외부 검색어' }).fill(query);
  await page.getByRole('button', { name: '적용', exact: true }).click();
}

test.describe('선택한 외부 웹 근거', () => {
  test('기본은 해제이며 검색어를 적어야 웹 포함 질문을 보낼 수 있다', async ({
    launch,
    openChat,
    shot,
  }) => {
    const page = await launch();
    await openChat(page);
    const toggle = page.getByRole('button', { name: '웹 검색', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByRole('textbox', { name: '외부 검색어' }),
    ).toHaveCount(0);
    await composer(page).fill('내부 정책과 외부 의견을 비교해 줘');
    const originalHeight =
      (await composer(page).locator('..').boundingBox())?.height ?? 0;
    await shot(page, '작은-웹-버튼');
    await toggle.click();
    const query = page.getByRole('textbox', { name: '외부 검색어' });
    await query.fill('   ');
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('검색어를 입력');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await query.fill('공개 센서 운영 지침');
    await expect(
      page.getByText('이 검색어만 외부로 보내요.', { exact: false }),
    ).toBeVisible();
    await shot(page, '웹-검색어-입력');
    await query.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(composer(page)).toHaveValue(
      '내부 정책과 외부 의견을 비교해 줘',
    );
    await toggle.click();
    await expect(query).toHaveValue('공개 센서 운영 지침');
    await page.getByRole('button', { name: '적용', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(query).toHaveCount(0);
    expect((await composer(page).locator('..').boundingBox())?.height).toBe(
      originalHeight,
    );
    await shot(page, '웹-적용-입력창');
    await toggle.click();
    await page.getByRole('button', { name: '사용 안 함', exact: true }).click();
    await expect(query).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.getByRole('button', { name: '질문 보내기' }),
    ).toBeEnabled();
  });

  test('웹 자료만으로도 답변 근거를 보관하고 다음 질문은 웹 해제로 돌아간다', async ({
    launch,
    app,
    openChat,
    shot,
  }) => {
    const page = await launch();
    await openChat(page);
    const content = '발췌 문장입니다. 센서 운영 지침의 외부 의견을 확인합니다.';
    const web = {
      query: '공개 센서 운영 지침',
      status: 'complete',
      sources: [
        {
          url: 'https://www.python.org/about/',
          title: '공개 운영 지침 · 격리 시험 자료',
          content,
          content_sha256: createHash('sha256').update(content).digest('hex'),
          retrieved_at: new Date().toISOString(),
        },
      ],
      warnings: [],
    };
    // 외부 조회만 격리 fixture로 교체하며 고정 근거·인용·대화 저장은 실제 서버를 사용합니다.
    await app().evaluate(({ ipcMain }, fixture) => {
      ipcMain.removeHandler('question-runs:web-search');
      ipcMain.handle('question-runs:web-search', (_event, request) => {
        if (
          request.query !== fixture.query ||
          'question' in request ||
          'documents' in request ||
          'attachments' in request
        )
          throw new Error(
            '웹 검색에는 별도로 입력한 검색어만 전달해야 합니다.',
          );
        return { web: fixture };
      });
    }, web);
    await includeWeb(page, web.query);
    await ask(page, '위키에 없는 주제의 외부 의견도 확인해 줘 #근거');
    const answer = await answered(page);
    await expect(answer).toContainText('외부 웹 자료 1개 확인');
    await expect(
      answer.getByRole('button', { name: /근거 1 확인 · 웹/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '웹 검색', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await answer.getByRole('button', { name: /근거 1 확인 · 웹/ }).click();
    const panel = page.getByRole('complementary', { name: '답변 근거' });
    await expect(panel).toContainText(web.sources[0]?.title ?? '');
    await expect(panel).toContainText('발췌 문장입니다.');
    await expect(
      panel.getByRole('link', { name: '외부 출처 열기' }),
    ).toHaveAttribute('href', web.sources[0]?.url ?? '');
    await expect(panel).toContainText('확인 시각');
    // 기본 브라우저를 실제로 띄우지 않고 명시 링크가 Electron 외부 열기 경계를 통과하는지 확인합니다.
    await app().evaluate(({ shell }) => {
      shell.openExternal = async (url: string): Promise<void> => {
        process.env.WIKI_TEST_WEB_SOURCE_URL = url;
      };
    });
    await panel.getByRole('link', { name: '외부 출처 열기' }).click();
    await expect
      .poll(async (): Promise<string | undefined> =>
        app().evaluate(
          (): string | undefined => process.env.WIKI_TEST_WEB_SOURCE_URL,
        ),
      )
      .toBe(web.sources[0]?.url);
    await shot(page, '웹-근거-보관');
    await panel
      .getByRole('button', { name: /답변 근거 닫기|대화로 돌아가기/ })
      .click();
    await ask(page, '이번에는 내부 근거만 확인해 줘 #후속');
    await expect(page).not.toHaveURL(/questionRunId=/u);
    await expect(
      conversation(page).getByRole('article').filter({ hasText: '답변' }),
    ).toHaveCount(2);
    await expect(
      conversation(page)
        .getByRole('article')
        .filter({ hasText: '답변' })
        .last(),
    ).toContainText('워크스페이스 근거만 사용');
  });

  test('웹 조회 실패를 보관하고 내부 근거로 답변을 계속한다', async ({
    launch,
    app,
    openChat,
    seedWiki,
    shot,
  }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await app().evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('question-runs:web-search');
      ipcMain.handle('question-runs:web-search', (_event, request) => ({
        web: {
          query: request.query,
          status: 'unavailable',
          sources: [],
          warnings: ['web_search_failed'],
        },
      }));
    });
    await includeWeb(page, '공개 센서 운영 지침');
    await ask(page, '센서 경고 온도 조건은? #근거');
    const answer = await answered(page);
    await expect(answer).toContainText('외부 웹 검색 · 조회하지 못함');
    await expect(
      answer.getByRole('button', { name: /근거 \d 확인/ }),
    ).toHaveCount(3);
    await shot(page, '웹-실패-내부-답변');
  });

  test('간결한 대화 목록에서 긴 제목과 작성 중 질문을 보존한다', async ({
    launch,
    openChat,
    shot,
  }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '센서 알림 기준을 정리해 줘 #정상');
    await answered(page);
    await newConversation(page);
    const longTitle =
      '운영 정책과 외부 자료의 차이를 비교하는 길고 자세한 질문입니다 #정상';
    await ask(page, longTitle);
    await answered(page);
    await newConversation(page);
    const draft = '다음 검토에서 확인할 사항을 정리해 줘';
    await composer(page).fill(draft);
    const history = page.getByRole('complementary', { name: '대화 목록' });
    await expect(history.getByText('저장된 대화', { exact: true })).toHaveCount(
      0,
    );
    await expect(history.getByText('작성 중', { exact: true })).toBeVisible();
    await expect(
      history.getByRole('button', { name: longTitle }),
    ).toHaveAttribute('title', longTitle);
    await history.getByRole('button', { name: longTitle }).click();
    await expect(conversation(page)).toContainText(longTitle);
    await history.getByRole('button', { name: /새 대화.*작성 중/u }).click();
    await expect(composer(page)).toHaveValue(draft);
    await shot(page, '간결한-대화-목록');
  });

  test('작은 창의 어두운 테마에서도 웹 설정이 화면 안에 열린다', async ({
    launch,
    app,
    openChat,
    shot,
  }) => {
    const page = await launch();
    await resize(app(), 960, 640);
    await app().evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await openChat(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute(
      'data-wiki-theme',
      'dark',
    );
    await page.getByRole('button', { name: '웹 검색', exact: true }).click();
    const popup = page.getByRole('dialog', { name: '웹 검색 설정' });
    await expect(popup).toBeVisible();
    const box = await popup.boundingBox();
    const inner = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(inner.width);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
      inner.height,
    );
    await shot(page, '작은창-웹-설정');
  });
});
