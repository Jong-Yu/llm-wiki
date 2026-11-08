import { test, expect } from './fixtures';
import { answered, ask, composer, conversation, newConversation } from './chat';

test.describe('정상 흐름', () => {
  test('01 빈 상태: 안내 문구와 비활성 전송 버튼', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await expect(page.getByText('무엇을 찾아볼까요?')).toBeVisible();
    await expect(page.getByText('대화가 없습니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '질문 보내기' })).toBeDisabled();
    await shot(page, '빈-상태');
  });

  test('02 입력 규칙: 공백만 있으면 보낼 수 없고 Shift+Enter는 줄바꿈', async ({ launch, openChat, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    await composer(page).fill('   ');
    await expect(page.getByRole('button', { name: '질문 보내기' })).toBeDisabled();
    await composer(page).press('Enter');
    await composer(page).fill('첫 줄');
    await composer(page).press('Shift+Enter');
    await composer(page).pressSequentially('둘째 줄');
    await expect(composer(page)).toHaveValue('첫 줄\n둘째 줄');
    await expect(page.getByRole('button', { name: '질문 보내기' })).toBeEnabled();
    await shot(page, '줄바꿈-입력');
    expect(await aiCalls()).toHaveLength(0);
  });

  test('03 문서 근거가 있는 정상 답변과 근거 버튼', async ({ launch, openChat, seedWiki, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await ask(page, '센서 경고 온도 조건은? #근거');
    await shot(page, '전송-직후');
    const answer = await answered(page);
    await expect(answer).toContainText('근거 문서를 확인했습니다');
    await expect(answer.getByRole('button', { name: /근거 \d 확인/ })).toHaveCount(3);
    await expect(conversation(page).getByText('검색으로 찾은 3개 문서')).toHaveCount(0);
    await expect(composer(page)).toHaveValue('');
    await shot(page, '근거-답변');
    await answer.getByRole('button', {name: /근거 1 확인/}).click();
    await expect(page.getByRole('complementary', {name: '답변 근거'}).getByText('검색으로 찾은 3개 문서')).toBeVisible();
    const calls = await aiCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scenario).toBe('근거');
  });

  test('04 근거 버튼을 열면 근거 내용이 보인다', async ({ launch, openChat, seedWiki, shot }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await ask(page, '센서 경고 온도 조건은? #근거');
    const answer = await answered(page);
    await answer.getByRole('button', { name: /근거 1 확인/ }).click();
    await shot(page, '근거-열림');
    await expect(page.getByText(/기준값은 설정 화면에서 바꿉니다|발췌/).first()).toBeVisible();
  });

  test('05 위키에 관련 문서가 없으면 근거 없이 답한다는 안내', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '전혀 상관없는 질문 #정상');
    const answer = await answered(page);
    await expect(answer).toContainText('문서에 따르면 센서는');
    await expect(answer.getByRole('button', { name: /근거 \d 확인/ })).toHaveCount(0);
    await shot(page, '문서-없음');
  });

  test('06 마크다운(제목·목록·표·코드·인용)이 구조대로 렌더된다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '서식 확인 #마크다운');
    const answer = await answered(page);
    await expect(answer.getByRole('heading', { name: '제목' })).toBeVisible();
    await expect(answer.getByRole('listitem')).toHaveCount(2);
    await expect(answer.getByRole('table')).toBeVisible();
    await expect(answer.locator('pre code')).toContainText("print('안녕')");
    await expect(answer.locator('blockquote')).toContainText('인용문');
    await expect(answer.locator('strong').filter({ hasText: '굵게' })).toHaveText('굵게');
    await shot(page, '마크다운');
  });

  test('07 답변 안의 HTML/스크립트는 실행되지 않고 문자로만 보인다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '보안 확인 #스크립트');
    await answered(page);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
    await expect(conversation(page).locator('script, img[src="x"]')).toHaveCount(0);
    await shot(page, '스크립트-차단');
  });

  test('08 한글·영문·이모지가 깨지지 않는다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '문자 확인 😀 English 한글 #한글영문');
    const answer = await answered(page);
    await expect(answer).toContainText('Sensor alarm 조건: threshold 초과 시 ALARM');
    await expect(answer).toContainText('✅ 😀');
    await expect(conversation(page)).toContainText('문자 확인 😀 English 한글');
    await shot(page, '문자-확인');
  });

  test('09 매우 긴 답변: 스크롤되고 입력창은 계속 보인다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '긴 답변 #긴답변');
    const answer = await answered(page);
    await expect(answer.getByRole('heading', { name: '항목 12' })).toBeAttached();
    await expect(composer(page)).toBeVisible();
    await shot(page, '긴-답변-끝');
    await conversation(page).evaluate((element) => {
      let node: HTMLElement | null = element;
      while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
      node?.scrollTo(0, 0);
    });
    await shot(page, '긴-답변-처음');
  });

  test('10 매우 긴 질문(수천 자)도 전송되고 그대로 보인다', async ({ launch, openChat, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    const long = `${'긴 질문입니다. '.repeat(400)}#정상`;
    await ask(page, long);
    await answered(page);
    await shot(page, '긴-질문');
    expect((await aiCalls())[0]?.scenario).toBe('정상');
  });

  test('11 여러 대화: 새 대화·전환 시 각 내용이 보존된다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '첫 번째 대화 #정상');
    await answered(page);
    await newConversation(page);
    await expect(page.getByText('무엇을 찾아볼까요?')).toBeVisible();
    await ask(page, '두 번째 대화 #마크다운');
    await answered(page);
    await shot(page, '두-대화');
    await page.getByRole('button', { name: /첫 번째 대화/ }).click();
    await expect(conversation(page)).toContainText('문서에 따르면 센서는');
    await expect(conversation(page)).not.toContainText('굵게');
    await shot(page, '첫-대화로-전환');
    await page.getByRole('button', { name: /두 번째 대화/ }).click();
    await expect(conversation(page)).toContainText('인용문');
  });

  test('12 대화 목록 패널을 접고 펼 수 있다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '목록 확인 #정상');
    await answered(page);
    await page.getByRole('button', { name: '대화 목록 닫기' }).click();
    await expect(page.getByRole('heading', { name: '이 기기의 대화' })).toBeHidden();
    await shot(page, '목록-닫힘');
  });
});
