import { test, expect } from './fixtures';
import { answered, ask, composer, conversation, failure, lingeringFakeAi } from './chat';

test.describe('진행 중 상태·취소·복원', () => {
  test('응답 대기 중 상태 표시와 중복 전송 방지', async ({ launch, openChat, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '지연 확인 #지연');
    await expect(page.getByRole('status').filter({ hasText: /답변을 준비하는 중|찾고 있어요|쓰는 중/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '응답 중단' })).toBeVisible();
    await expect(conversation(page)).toContainText('지연 확인 #지연');
    await shot(page, '응답-대기중');
    // 대기 중에 같은 입력을 다시 보내도 AI는 한 번만 실행된다.
    await composer(page).fill('또 보냄 #정상');
    await composer(page).press('Enter');
    await answered(page);
    await expect(page.getByRole('button', { name: '응답 중단' })).toBeHidden();
    await shot(page, '응답-완료');
    expect((await aiCalls()).filter((call) => call.scenario === '지연')).toHaveLength(1);
    expect((await aiCalls()).filter((call) => call.question.includes('또 보냄'))).toHaveLength(0);
  });

  test('응답 중단: 화면이 대기 상태를 벗어나고 AI 프로세스가 남지 않는다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '오래 걸리는 질문 #느림');
    const stop = page.getByRole('button', { name: '응답 중단' });
    await expect(stop).toBeVisible();
    await expect.poll(lingeringFakeAi).toBeGreaterThan(0);
    await shot(page, '중단-전');
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 20_000 });
    await shot(page, '중단-후');
    await expect(conversation(page)).toContainText('오래 걸리는 질문');
    await expect(conversation(page).getByRole('button', { name: /근거 \d 확인/ })).toHaveCount(0);
    await expect.poll(lingeringFakeAi, { timeout: 20_000 }).toBe(0);
    await expect(composer(page)).toBeEnabled();
  });

  test('응답 중단 뒤 새 질문을 보내면 정상 답변을 받는다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '중단할 질문 #느림');
    await page.getByRole('button', { name: '응답 중단' }).click();
    await expect(page.getByRole('button', { name: '응답 중단' })).toBeHidden({ timeout: 20_000 });
    await ask(page, '다시 질문 #정상');
    const answer = await answered(page);
    await expect(answer).toContainText('문서에 따르면 센서는');
    await shot(page, '중단-후-정상');
  });

  test('답변 대기 중 다른 화면에 갔다 돌아와도 답변이 도착한다', async ({ launch, openChat, shot }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '이동 확인 #지연');
    await expect(page.getByRole('button', { name: '응답 중단' })).toBeVisible();
    await page.getByRole('link', { name: '문서', exact: true }).click();
    await expect(page.getByRole('heading', { name: '문서', level: 1 })).toBeVisible();
    await shot(page, '다른-화면');
    await page.getByRole('link', { name: 'AI 채팅' }).click();
    const answer = await answered(page);
    await expect(answer).toContainText('문서에 따르면 센서는');
    await shot(page, '돌아온-채팅');
  });

  test('후속 질문은 같은 대화에 이어지고 이전 내용이 유지된다', async ({ launch, openChat, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    await ask(page, '첫 질문 #정상');
    await answered(page);
    await ask(page, '이어서 질문 #정상');
    await expect(conversation(page).getByRole('article').filter({ hasText: '답변' })).toHaveCount(2);
    await expect(conversation(page)).toContainText('첫 질문');
    await expect(conversation(page)).toContainText('이어서 질문');
    await shot(page, '후속-질문');
    const calls = await aiCalls();
    expect(calls).toHaveLength(2);
    // 두 번째 호출이 세션을 이어 갔는지는 관찰만 한다(앱 정책에 따라 다름).
    test.info().annotations.push({ type: 'resume', description: `두 번째 호출 resume=${String(calls[1]?.resumed)}` });
  });

  test('앱을 다시 시작해도 연결과 대화 목록이 복원된다', async ({ launch, openChat, app, shot }) => {
    const first = await launch();
    await openChat(first);
    await ask(first, '복원 확인 #정상');
    await answered(first);
    await app().close();
    const page = await launch();
    await page.getByRole('link', { name: 'AI 채팅' }).click({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /복원 확인/ })).toBeVisible();
    await shot(page, '재시작-후-목록');
    await page.getByRole('button', { name: /복원 확인/ }).click();
    await expect(conversation(page)).toContainText('문서에 따르면 센서는');
    await shot(page, '재시작-후-대화');
  });

  test('실패한 대화도 앱 재시작 뒤 질문이 보존된다', async ({ launch, openChat, app, shot }) => {
    const first = await launch();
    await openChat(first);
    await ask(first, '실패 복원 #로그인실패');
    await expect(failure(first)).toBeVisible();
    await app().close();
    const page = await launch();
    await page.getByRole('link', { name: 'AI 채팅' }).click({ timeout: 30_000 });
    await shot(page, '실패-재시작-목록');
    await expect(page.getByText('실패 복원').first()).toBeVisible();
  });
});
