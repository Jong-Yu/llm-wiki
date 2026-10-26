import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { openAppPage } from '../helpers/navigation';

/** 실제 Electron을 종료한 뒤 별도 프로세스에서 저장 설정을 확인합니다. */
test('개인 실행 환경 진입·읽기 전용 진단·설정 저장·별도 프로세스 재시작', async (): Promise<void> => {
  test.setTimeout(120000);
  const profile = await mkdtemp(join(tmpdir(), 'ui11-runtime-electron-'));
  let application: ElectronApplication | null = null;
  try {
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: {
        ...process.env,
        WIKI_CLIENT_ROOT: resolve('..'),
        WIKI_PYTHON: resolve('../.venv/bin/python'),
        WIKI_AI_PROVIDER: 'codex',
        WIKI_CLAUDE_CLI: '/nonexistent/claude-ui-fixture',
      },
    });
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1280, height: 720 });
    await openAppPage(page, '작업 공간');
    await page
      .getByRole('link', { name: '개인 실행 환경', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '개인 실행 환경', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Codex', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('button', { name: 'Claude Code', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Claude Code', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByText(/현재 실행: Codex · 다음 시작 선택: Claude Code/),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '설치·로그인 진단', exact: true })
      .click();
    await expect(
      page.getByText('Python 3.12 이상 · ok', { exact: true }),
    ).toBeVisible({ timeout: 70000 });
    await expect(
      page.getByText('Claude Code CLI·로그인 · error', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '다음 시작에 적용하도록 저장', exact: true })
      .click();
    await expect(
      page.getByText(
        '설정을 저장했습니다. 앱을 완전히 종료하고 다시 열어 주세요.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('runtime-1280.png'),
      fullPage: true,
    });
    const first = await page.evaluate(async () =>
      window.wiki?.runtime.execute({ operation: 'read' }),
    );
    expect(first).toMatchObject({
      ok: true,
      data: {
        saved: true,
        restartRequired: true,
        activeProvider: 'codex',
        settings: { provider: 'claude' },
      },
    });
    await application.close();
    application = null;
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry: [string, string | undefined]): entry is [string, string] =>
            entry[1] !== undefined,
        ),
      ),
    });
    const restored = await application.firstWindow();
    expect(
      await restored.evaluate(async () =>
        window.wiki?.runtime.execute({ operation: 'read' }),
      ),
    ).toMatchObject({
      ok: true,
      data: {
        saved: true,
        activeProvider: 'claude',
        restartRequired: false,
        settings: {
          root: resolve('..'),
          python: resolve('../.venv/bin/python'),
          provider: 'claude',
          claude: '/nonexistent/claude-ui-fixture',
        },
      },
    });
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
