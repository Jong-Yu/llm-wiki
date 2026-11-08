import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

/** 질문 입력창입니다. 접근 가능한 이름("질문")으로 찾아 디자인 변경에 덜 민감하게 합니다. */
export const composer = (page: Page): Locator => page.getByRole('textbox', { name: '질문' });
/** 대화(질문·답변) 영역입니다. */
export const conversation = (page: Page): Locator => page.getByRole('log', { name: '질문과 답변' });
/** 마지막 오류 안내입니다. 오류 영역(role=alert)이 여러 개일 수 있어 오류 코드("자세히") 문구로 찾습니다. */
export const failure = (page: Page): Locator => page.getByRole('alert').filter({ hasText: '자세히' });

/** 질문을 입력하고 Enter로 보냅니다. */
export async function ask(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** 답변 한 건이 저장 확인까지 끝나 화면에 나타날 때까지 기다립니다. */
export async function answered(page: Page): Promise<Locator> {
  const answer = conversation(page).getByRole('article').filter({ hasText: '답변' }).last();
  await expect(answer).toBeVisible();
  return answer;
}

/** 새 대화를 시작합니다. */
export async function newConversation(page: Page): Promise<void> {
  await page.getByRole('button', { name: '새 대화' }).click();
}

/** 창 크기를 바꿉니다. Electron에서는 페이지 뷰포트가 아니라 창 자체를 조절해야 합니다. */
export async function resize(application: ElectronApplication, width: number, height: number): Promise<void> {
  await application.evaluate(({ BrowserWindow }, size) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setSize(size.width, size.height);
  }, { width, height });
}

/** 가짜 AI가 남아 있는지 확인합니다(취소·종료 뒤 고아 프로세스 검사). */
export function lingeringFakeAi(): number {
  try {
    return execFileSync('pgrep', ['-f', 'fake-ai/codex exec']).toString().trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
