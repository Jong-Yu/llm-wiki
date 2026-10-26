import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron, expect, test } from '@playwright/test';

test('공통 UI 묶음의 입력·키보드·포커스·상태 보존', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-shared-ui-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await build({
      configFile: false,
      root: resolve('tests/fixtures'),
      base: './',
      logLevel: 'silent',
      plugins: [react()],
      resolve: { alias: { '@renderer': resolve('src/renderer') } },
      build: {
        outDir: join(directory, 'ui'),
        emptyOutDir: true,
        rolldownOptions: { input: resolve('tests/fixtures/shared-ui.html') },
      },
    });
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(directory, 'profile')}`],
    });
    await application.firstWindow();
    const opened = application.waitForEvent('window');
    await application.evaluate(
      async ({ BrowserWindow }, file) => {
        const window = new BrowserWindow({
          width: 1000,
          height: 900,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await window.loadFile(file);
      },
      join(directory, 'ui/shared-ui.html'),
    );
    const page = await opened;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const name = page.getByRole('textbox', { name: '이름', exact: true });
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(
      '외부 도움말 이름 도움말 이름을 입력하세요',
    );
    await name.fill('공통 입력');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('textbox', { name: '설명' }).fill('여러 줄\n입력');
    await page.getByRole('combobox', { name: '분류' }).selectOption('b');
    await expect(page.getByRole('combobox', { name: '분류' })).toHaveValue('b');
    await expect(
      page.getByRole('button', { name: '사용 불가' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '입력으로 이동' }).click();
    await expect(name).toBeFocused();
    await expect(page.getByLabel('제출 횟수')).toHaveText('0');
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await expect(page.getByLabel('제출 횟수')).toHaveText('1');

    await page
      .getByRole('textbox', { name: '보존할 입력' })
      .fill('유지되는 값');
    const first = page.getByRole('tab', { name: '첫 탭' });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    const last = page.getByRole('tab', { name: '끝 탭' });
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('status').filter({ hasText: '준비됨' }),
    ).toHaveText('준비됨두 번째 패널');
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    await expect(
      page.getByRole('textbox', { name: '보존할 입력' }),
    ).toHaveValue('유지되는 값');
    await page.keyboard.press('End');
    await expect(last).toBeFocused();

    const trigger = page.getByRole('button', { name: '대화상자 열기' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '동작 확인' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      '입력은 닫아도 유지됩니다',
    );
    await dialog
      .getByRole('textbox', { name: '대화상자 입력' })
      .fill('대화상자 초안');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(
      dialog.getByRole('textbox', { name: '대화상자 입력' }),
    ).toHaveValue('대화상자 초안');
    await dialog.getByRole('button', { name: '완료' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel('제출 횟수')).toHaveText('1');
    await page.getByRole('button', { name: '테마 전환' }).click();
    await expect(page.locator('.wiki-theme')).toHaveAttribute(
      'data-wiki-theme',
      'dark',
    );
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
