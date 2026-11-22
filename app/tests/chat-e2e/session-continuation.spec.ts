import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { ask, composer, conversation, failure } from './chat';
import { expect, test } from './fixtures';

/** 입력창 밖에 같은 비용 안내가 중복되어도 잡도록 화면 전체에서 셉니다. */
const tokenHints = (page: Page): Locator => page.getByText(/토큰이 더 쓰/);
const answers = (page: Page): Locator =>
  conversation(page).getByRole('article').filter({ hasText: '답변' });

/** 첫 질문과 답변을 저장해 다음 질문에 전달할 대화 이력을 만듭니다. */
async function saveFirstExchange(page: Page): Promise<void> {
  await ask(page, '세션 확인 첫 질문 #정상');
  await expect(answers(page)).toHaveCount(1);
}

/** 이번 실행의 격리 userData와 현재 화면의 대화 ID로만 포인터를 지정합니다. */
async function fixturePointer(
  application: ElectronApplication,
  page: Page,
  workRoot: string,
): Promise<string> {
  const directory = await application.evaluate(({ app }) =>
    app.getPath('userData'),
  );
  expect(dirname(dirname(directory))).toBe(workRoot);
  await expect(page).toHaveURL(/conversationId=[0-9a-f]{32}/);
  const route = new URL(page.url()).hash;
  const id = new URLSearchParams(route.slice(route.indexOf('?') + 1)).get(
    'conversationId',
  );
  if (!id || !/^[0-9a-f]{32}$/.test(id))
    throw new Error('격리 대화 ID를 확인하지 못했습니다.');
  return join(directory, 'question-sessions', 'pointers', `${id}.codex.json`);
}

test('기록 없는 새 대화에는 토큰 안내가 없다', async ({
  launch,
  openChat,
  aiCalls,
}) => {
  const page = await launch();
  await openChat(page);
  await expect(page.getByText('무엇을 찾아볼까요?')).toBeVisible();
  await expect(page.getByText('대화가 없습니다')).toBeVisible();
  await expect(composer(page)).toBeEnabled();
  await expect(tokenHints(page)).toHaveCount(0);
  expect(await aiCalls()).toHaveLength(0);
});

test('선택 근거 질문은 로컬 포인터 없이 대화 재전송을 한 번 안내하고 오류 시 숨긴다', async ({
  launch,
  openChat,
  app,
  workRoot,
  aiCalls,
}) => {
  const page = await launch();
  await openChat(page);
  await saveFirstExchange(page);
  await ask(page, '세션 확인 둘째 질문 #정상');
  await expect(answers(page)).toHaveCount(2);
  await expect(composer(page)).toBeEnabled();
  const pointer = await fixturePointer(app(), page, workRoot);
  // D-108의 v5/v6 질문은 native resume 없이 저장된 대화를 각 모델 호출에 제공합니다.
  await expect(access(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
  // 창 복귀 때 실제 IPC로 재조회해도 없는 포인터를 재개 가능하다고 표시하면 안 됩니다.
  await page.evaluate((): void => {
    window.dispatchEvent(new Event('focus'));
  });
  await expect(answers(page)).toHaveCount(2);
  await expect(tokenHints(page)).toHaveCount(1);
  await expect(tokenHints(page)).toBeVisible();
  await expect(composer(page)).toHaveAccessibleDescription(
    /이전 메시지 4개를 AI에 다시 전달/,
  );
  expect(await aiCalls()).toHaveLength(2);

  await ask(page, '오류 상태 확인 #로그인실패');
  const alert = failure(page);
  await expect(alert).toHaveCount(1);
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('AI 실행 환경을 확인해 주세요');
  await expect(alert).not.toContainText('ai_login_or_execution_failed');
  await expect(tokenHints(page)).toHaveCount(0);
  await expect(composer(page)).toHaveAttribute(
    'placeholder',
    '질문을 수정해서 다시 보낼 수도 있어요',
  );
  const calls = await aiCalls();
  expect(calls).toHaveLength(3);
  expect(calls.at(-1)).toMatchObject({
    scenario: '로그인실패',
    resumed: false,
  });
});

test('후속 선택 근거 질문은 새 AI 문맥으로 한 번 실행하고 서버 대화를 보존한다', async ({
  launch,
  openChat,
  app,
  workRoot,
  aiCalls,
}) => {
  const page = await launch();
  await openChat(page);
  await saveFirstExchange(page);
  await ask(page, '세션 확인 둘째 질문 #지연');
  await expect(page.getByRole('button', { name: '응답 중단' })).toBeVisible();
  // native 세션 재개/재전송 이벤트가 없는 선택 근거 실행에 해당 안내를 만들지 않습니다.
  await expect(tokenHints(page)).toHaveCount(0);
  await expect(answers(page)).toHaveCount(2);
  await expect(composer(page)).toBeEnabled();
  const pointer = await fixturePointer(app(), page, workRoot);
  await expect(access(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(tokenHints(page)).toHaveText([
    '다음 질문을 보내면 이전 메시지 4개를 AI에 다시 전달해요. 토큰이 더 쓰일 수 있어요.',
  ]);

  await ask(page, '세션 확인 셋째 질문 #정상');
  await expect(answers(page)).toHaveCount(3);
  await expect(conversation(page)).toContainText('세션 확인 첫 질문 #정상');
  await expect(conversation(page)).toContainText('세션 확인 둘째 질문 #지연');
  await expect(tokenHints(page)).toHaveText([
    '다음 질문을 보내면 이전 메시지 6개를 AI에 다시 전달해요. 토큰이 더 쓰일 수 있어요.',
  ]);
  const calls = await aiCalls();
  expect(calls).toHaveLength(3);
  expect(calls[1]).toMatchObject({ scenario: '지연', resumed: false });
  for (const call of calls) {
    expect(call.resumed).toBe(false);
    expect(call.arguments).not.toContain('resume');
    expect(call.arguments).toContain('--ephemeral');
  }
  await expect(access(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
});
