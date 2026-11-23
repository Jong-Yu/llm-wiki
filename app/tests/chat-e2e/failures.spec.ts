import { test, expect } from './fixtures';
import { answered, ask, composer, conversation, failure } from './chat';

/** [시나리오, 기대 오류 코드]. D-145의 미완료 본문과 저장된 답변을 구분합니다. */
const cases: Array<[string, string]> = [
  ['로그인실패', 'ai_login_or_execution_failed'],
  ['비정상종료', 'ai_incomplete_turn'],
  ['이벤트오류', 'ai_execution_failed'],
  ['도구호출', 'ai_unexpected_tool_activity'],
  ['미완료', 'ai_incomplete_turn'],
  ['빈답변', 'ai_invalid_result'],
  ['스키마위반', 'ai_invalid_result'],
  ['깨진JSON', 'ai_invalid_result'],
  ['인용위조', 'ai_invalid_result'],
];

test.describe('AI 실행 실패', () => {
  for (const [scenario, code] of cases) {
    test(`${scenario}: 오류 안내와 질문 보존 (${code})`, async ({
      launch,
      openChat,
      seedWiki,
      shot,
      aiCalls,
    }) => {
      const page = await launch();
      await openChat(page);
      await seedWiki();
      await ask(page, `센서 경고 온도 조건은? #${scenario}`);
      await expect(failure(page)).toBeVisible();
      const connection = code === 'ai_login_or_execution_failed';
      const title = connection
        ? 'AI 실행 환경을 확인해 주세요'
        : code === 'ai_unexpected_tool_activity'
          ? '도구 실행이 허용되지 않아 답변을 중단했어요'
          : code === 'ai_incomplete_turn'
            ? '답변이 끝나기 전에 실행이 종료됐어요'
            : code === 'ai_execution_failed'
              ? '답변 처리 중 오류가 발생했어요'
            : '답변 결과를 확인하지 못했어요';
      await expect(failure(page)).toContainText(title);
      await expect(failure(page)).not.toContainText(code);
      // 연결 문제에는 설정, 다른 실행 실패에는 해당 요청의 재시도를 제공한다.
      if (connection)
        await expect(
          page.getByRole('link', { name: 'AI 연결하기' }),
        ).toBeVisible();
      else {
        await expect(failure(page)).toContainText('질문은 그대로 남아 있어요');
        await expect(
          page.getByRole('button', { name: '다시 시도' }),
        ).toBeVisible();
        await expect(
          page.getByRole('link', { name: 'AI 연결하기' }),
        ).toHaveCount(0);
      }
      // 질문은 사라지지 않고 대화에 남아 있어야 한다.
      await expect(conversation(page)).toContainText(`#${scenario}`);
      // 공개 본문을 받은 뒤 실패하면 부분 내용만 표시하며 JSON·근거·확정 답변으로 승격하지 않는다.
      await expect(conversation(page)).not.toContainText('저장 미확인');
      const partial = ['미완료', '깨진JSON', '인용위조'].includes(scenario);
      if (partial)
        await expect(conversation(page)).toContainText('오류 전 생성된 내용');
      await expect(conversation(page)).not.toContainText('"action"');
      await expect(conversation(page)).not.toContainText('[[s999:');
      await expect(
        conversation(page).getByText('AI', { exact: true }),
      ).toHaveCount(partial ? 1 : 0);
      await expect(conversation(page).getByRole('article')).toHaveCount(1);
      await expect(
        conversation(page).getByRole('button', { name: /근거 \d 확인/ }),
      ).toHaveCount(0);
      await shot(page, `${scenario}-오류`);
      // 실패 뒤 자동으로 다시 실행하지 않는다(질문 호출 1회).
      await page.waitForTimeout(1500);
      expect(await aiCalls()).toHaveLength(1);
    });
  }

  test('답변 다시 시도는 사용자가 누를 때만 한 번 더 실행한다', async ({
    launch,
    openChat,
    seedWiki,
    shot,
    aiCalls,
  }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await ask(page, '센서 경고 온도 조건은? #도구호출');
    await expect(failure(page)).toBeVisible();
    expect(await aiCalls()).toHaveLength(1);
    await page.getByRole('button', { name: '다시 시도' }).click();
    await expect.poll(async () => (await aiCalls()).length).toBe(2);
    await expect(failure(page)).toBeVisible();
    await shot(page, '재시도-다시-실패');
    await page.waitForTimeout(1500);
    expect(await aiCalls()).toHaveLength(2);
  });

  test('실패 뒤에도 새 질문을 보내면 정상 답변을 받는다', async ({
    launch,
    openChat,
    seedWiki,
    shot,
  }) => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    await ask(page, '첫 질문 #로그인실패');
    await expect(failure(page)).toBeVisible();
    await ask(page, '둘째 질문 #정상');
    const answer = await answered(page);
    await expect(answer).toContainText('문서에 따르면 센서는');
    await expect(conversation(page)).toContainText(
      'AI 실행 환경을 확인해 주세요',
    );
    await shot(page, '실패-후-정상');
  });

  test('AI 실행 파일이 없으면 연결 확인 안내가 나온다', async ({
    launch,
    openChat,
    shot,
    aiCalls,
  }) => {
    const page = await launch({ cli: '/없는/경로/codex' });
    await openChat(page);
    await ask(page, '센서 경고 온도 조건은? #정상');
    await expect(failure(page)).toBeVisible();
    await expect(failure(page)).toContainText('AI 실행 환경을 확인해 주세요');
    // 연결 문제를 확인·고칠 수 있도록 AI 설정으로 가는 링크가 나온다.
    await expect(page.getByRole('link', { name: 'AI 연결하기' })).toBeVisible();
    await shot(page, 'CLI-없음');
    expect(await aiCalls()).toHaveLength(0);
  });

  test('서버 연결이 끊기면 상태를 안내하고 질문을 잃지 않는다', async ({
    launch,
    openChat,
    server,
    shot,
    aiCalls,
  }) => {
    const page = await launch();
    await openChat(page);
    await expect(composer(page)).toBeEnabled();
    await shot(page, '서버-연결-정상');
    await server.stop();
    // 빈 채팅으로 돌아오는 것만으로는 서버 조회가 보장되지 않습니다. 실제 질문의 근거 검색을 시도합니다.
    const question = '서버 끊김 중 질문 #정상';
    await ask(page, question);
    const banner = page
      .getByRole('alert')
      .filter({ hasText: '서버에 연결할 수 없습니다' });
    await expect(banner).toBeVisible();
    await expect(composer(page)).toHaveValue(question);
    await expect(composer(page)).toBeEnabled();
    expect(await aiCalls()).toHaveLength(0);
    await shot(page, '서버-끊김-안내와-질문-보존');
  });
});
