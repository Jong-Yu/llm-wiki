import { readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { ask, composer, conversation } from './chat';
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
  const directory = await application.evaluate(({ app }) => app.getPath('userData'));
  expect(dirname(dirname(directory))).toBe(workRoot);
  await expect(page).toHaveURL(/conversationId=[0-9a-f]{32}/);
  const route = new URL(page.url()).hash;
  const id = new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('conversationId');
  if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error('격리 대화 ID를 확인하지 못했습니다.');
  return join(directory, 'question-sessions', 'pointers', `${id}.codex.json`);
}

test('기록 없는 새 대화에는 토큰 안내가 없다', async ({ launch, openChat, aiCalls }) => {
  const page = await launch();
  await openChat(page);
  await expect(page.getByText('무엇을 찾아볼까요?')).toBeVisible();
  await expect(page.getByText('대화가 없습니다')).toBeVisible();
  await expect(composer(page)).toBeEnabled();
  await expect(tokenHints(page)).toHaveCount(0);
  expect(await aiCalls()).toHaveLength(0);
});

test('저장된 대화의 로컬 포인터가 사라지면 토큰 안내가 한 번 보이고 오류 시 사라진다', async ({
  launch, openChat, app, workRoot, aiCalls,
}) => {
  const page = await launch();
  await openChat(page);
  await saveFirstExchange(page);
  await ask(page, '세션 확인 둘째 질문 #정상');
  await expect(answers(page)).toHaveCount(2);
  await expect(composer(page)).toBeEnabled();
  const pointer = await fixturePointer(app(), page, workRoot);
  // 서버 기록·인증은 보존하고 이 테스트가 생성한 대화의 포인터 한 파일만 격리합니다.
  await rename(pointer, join(workRoot, 'saved-pointer.json'));
  // 창 복귀 시 제품이 실제 IPC로 다시 확인하게 합니다. 대화·실행의 주소는 그대로 둡니다.
  await page.evaluate((): void => { window.dispatchEvent(new Event('focus')); });
  await expect(answers(page)).toHaveCount(2);
  await expect(tokenHints(page)).toHaveCount(1);
  await expect(tokenHints(page)).toBeVisible();
  await expect(composer(page)).toHaveAccessibleDescription(/이전 메시지 4개를 AI에 다시 전달/);
  expect(await aiCalls()).toHaveLength(2);

  await ask(page, '오류 상태 확인 #로그인실패');
  const alert = page.getByRole('alert').filter({ hasText: 'ai_login_or_execution_failed' });
  await expect(alert).toHaveCount(1);
  await expect(alert).toBeVisible();
  await expect(tokenHints(page)).toHaveCount(0);
  await expect(composer(page)).toHaveAttribute('placeholder', '질문을 수정해서 다시 보낼 수도 있어요');
  const calls = await aiCalls();
  expect(calls).toHaveLength(3);
  expect(calls.at(-1)).toMatchObject({ scenario: '로그인실패', resumed: false });
});

test('정상 재개는 저장된 CLI 세션으로 한 번 이어가고 토큰 안내가 없다', async ({
  launch, openChat, app, workRoot, aiCalls,
}) => {
  const page = await launch();
  await openChat(page);
  await saveFirstExchange(page);
  await ask(page, '세션 확인 둘째 질문 #지연');
  await expect(page.getByRole('button', { name: '응답 중단' })).toBeVisible();
  // 첫 후속 질문의 session_history_replay 이벤트가 실행 중 안내 한 개로 표시되어야 합니다.
  await expect(tokenHints(page)).toHaveText([
    '새 AI 세션에 저장된 대화를 다시 전달하고 있어요. 토큰이 더 쓰일 수 있어요.',
  ]);
  await expect(tokenHints(page)).toBeVisible();
  await expect(answers(page)).toHaveCount(2);
  await expect(composer(page)).toBeEnabled();
  const pointer = await fixturePointer(app(), page, workRoot);
  const saved: unknown = JSON.parse(await readFile(pointer, 'utf8'));
  await expect(tokenHints(page)).toHaveCount(0);

  await ask(page, '세션 확인 셋째 질문 #정상');
  await expect(answers(page)).toHaveCount(3);
  await expect(answers(page).last()).toContainText('이전 질문을 이어서 답합니다.');
  await expect(tokenHints(page)).toHaveCount(0);
  const calls = await aiCalls();
  expect(calls).toHaveLength(3);
  expect(calls[1]).toMatchObject({ scenario: '지연', resumed: false });
  const last = calls[2];
  expect(last.resumed).toBe(true);
  const sessionId = last.arguments[last.arguments.indexOf('resume') + 1];
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(saved).toMatchObject({ session_id: sessionId });
});
