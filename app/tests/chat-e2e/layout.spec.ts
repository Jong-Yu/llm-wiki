import { test, expect } from './fixtures';
import { answered, ask, composer, resize } from './chat';

test.describe('화면 크기·테마·키보드', () => {
  for (const [width, height] of [
    [1440, 900],
    [1100, 760],
    [960, 640],
  ] as const) {
    test(`창 크기 ${width}x${height}에서 입력창과 답변이 모두 보인다`, async ({
      launch,
      openChat,
      app,
      shot,
    }) => {
      const page = await launch();
      await resize(app(), width, height);
      await openChat(page);
      await ask(page, `크기 확인 #마크다운`);
      const answer = await answered(page);
      await expect(composer(page)).toBeVisible();
      // 창에는 최소 크기(960x640)가 있어 요청보다 크게 잡힐 수 있으므로 실제 화면 크기를 기준으로 비교한다.
      const inner = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(inner.width).toBeGreaterThanOrEqual(Math.min(width, 960) - 20);
      const box = await composer(page).boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        inner.width + 1,
      );
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
        inner.height + 1,
      );
      // 가로 스크롤이 생기지 않아야 한다.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      await expect(answer).toBeVisible();
      await shot(page, `크기-${width}x${height}`);
    });
  }

  test('어두운 테마에서도 채팅이 읽힌다', async ({
    launch,
    openChat,
    app,
    shot,
  }) => {
    const page = await launch();
    await app().evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await openChat(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute(
      'data-wiki-theme',
      'dark',
    );
    await ask(page, '테마 확인 #마크다운');
    await answered(page);
    await shot(page, '어두운-테마');
  });

  test('키보드만으로 질문을 입력·전송할 수 있다', async ({
    launch,
    openChat,
    shot,
  }) => {
    const page = await launch();
    await openChat(page);
    // focus()만으로는 Electron 창에서 글자가 들어가지 않아(관찰) 실제 사용처럼 클릭해서 포커스를 준다.
    await composer(page).click();
    await page.keyboard.type('키보드 질문 #정상');
    // 입력한 글자가 화면 갱신으로 지워지지 않았는지 먼저 확인한다.
    await expect(composer(page)).toHaveValue('키보드 질문 #정상');
    await shot(page, '키보드-입력');
    await page.keyboard.press('Enter');
    await answered(page);
    await expect(composer(page)).toHaveValue('');
  });

  test('옵션 메뉴(+)를 열 수 있다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await page.getByRole('button', { name: '옵션 열기' }).click();
    await shot(page, '옵션-메뉴');
    await page.keyboard.press('Escape');
    await expect(composer(page)).toBeVisible();
  });
});
