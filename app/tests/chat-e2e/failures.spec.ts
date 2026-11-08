import { test, expect } from './fixtures';
import { answered, ask, composer, conversation, failure } from './chat';

/** [시나리오, 기대 오류 코드, 저장되지 않은 응답 초안이 "저장 미확인"으로 표시되는지] */
const cases: Array<[string, string, boolean]> = [
  ['로그인실패', 'ai_login_or_execution_failed', false],
  ['비정상종료', 'ai_login_or_execution_failed', false],
  ['이벤트오류', 'ai_login_or_execution_failed', false],
  ['도구호출', 'ai_unexpected_tool_activity', true],
  ['미완료', 'ai_incomplete_turn', true],
  ['빈답변', 'ai_invalid_result', false],
  ['스키마위반', 'ai_invalid_result', false],
  ['깨진JSON', 'ai_invalid_result', true],
  ['인용위조', 'ai_invalid_result', true],
];

test.describe('AI 실행 실패', () => {
  for (const [scenario, code, draft] of cases) {
    test(`${scenario}: 오류 안내와 질문 보존 (${code})`, async ({ launch, openChat, seedWiki, shot, aiCalls }) => {
      const page = await launch();
      await openChat(page);
      await seedWiki();
      await ask(page, `센서 경고 온도 조건은? #${scenario}`);
      await expect(failure(page)).toBeVisible();
      await expect(failure(page)).toContainText('답변을 만들지 못했어요');
      await expect(failure(page)).toContainText(`자세히: ${code}`);
      await expect(failure(page)).toContainText('질문은 그대로 남아 있어요');
      await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();
      // 연결 문제를 확인·고칠 수 있도록 AI 설정으로 가는 링크가 함께 나온다.
      await expect(page.getByRole('link', { name: 'AI 연결 확인' })).toBeVisible();
      // 질문은 사라지지 않고 대화에 남아 있어야 한다.
      await expect(conversation(page)).toContainText(`#${scenario}`);
      // 검증되지 않은 응답 초안은 확정 답변처럼 보이면 안 된다.
      if (draft) await expect(conversation(page)).toContainText('저장 미확인');
      await expect(conversation(page).getByRole('button', { name: /근거 \d 확인/ })).toHaveCount(0);
      await shot(page, `${scenario}-오류`);
      // 실패 뒤 자동으로 다시 실행하지 않는다(질문 호출 1회).
      await page.waitForTimeout(1500);
      expect(await aiCalls()).toHaveLength(1);
    });
  }

  test('답변 다시 시도는 사용자가 누를 때만 한 번 더 실행한다', async ({ launch, openChat, seedWiki, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await ask(page, '센서 경고 온도 조건은? #로그인실패');
    await expect(failure(page)).toBeVisible();
    expect(await aiCalls()).toHaveLength(1);
    await page.getByRole('button', { name: '다시 시도' }).click();
    await expect.poll(async () => (await aiCalls()).length).toBe(2);
    await expect(failure(page)).toBeVisible();
    await shot(page, '재시도-다시-실패');
    await page.waitForTimeout(1500);
    expect(await aiCalls()).toHaveLength(2);
  });

  test('실패 뒤에도 새 질문을 보내면 정상 답변을 받는다', async ({ launch, openChat, seedWiki, shot }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await ask(page, '첫 질문 #로그인실패');
    await expect(failure(page)).toBeVisible();
    await ask(page, '둘째 질문 #정상');
    const answer = await answered(page);
    await expect(answer).toContainText('문서에 따르면 센서는');
    await shot(page, '실패-후-정상');
  });

  test('AI 실행 파일이 없으면 연결 확인 안내가 나온다', async ({ launch, openChat, shot, aiCalls }) => {
    const page = await launch({ cli: '/없는/경로/codex' });
    await openChat(page);
    await ask(page, '센서 경고 온도 조건은? #정상');
    await expect(failure(page)).toBeVisible();
    await expect(failure(page)).toContainText('자세히:');
    // 연결 문제를 확인·고칠 수 있도록 AI 설정으로 가는 링크가 나온다.
    await expect(page.getByRole('link', { name: 'AI 연결 확인' })).toBeVisible();
    await shot(page, 'CLI-없음');
    expect(await aiCalls()).toHaveLength(0);
  });

  test('서버 연결이 끊기면 상태를 안내하고 질문을 잃지 않는다', async ({ launch, openChat, server, shot, aiCalls }) => {
    const page = await launch();
    await openChat(page);
    await expect(composer(page)).toBeEnabled();
    await shot(page, '서버-연결-정상');
    await server.stop();
    // 빈 채팅으로 돌아오는 것만으로는 서버 조회가 보장되지 않습니다. 실제 질문의 근거 검색을 시도합니다.
    const question = '서버 끊김 중 질문 #정상';
    await ask(page, question);
    const banner = page.getByRole('alert').filter({ hasText: '서버에 연결할 수 없습니다' });
    await expect(banner).toBeVisible();
    await expect(composer(page)).toHaveValue(question);
    await expect(composer(page)).toBeEnabled();
    expect(await aiCalls()).toHaveLength(0);
    await shot(page, '서버-끊김-안내와-질문-보존');
  });
});
