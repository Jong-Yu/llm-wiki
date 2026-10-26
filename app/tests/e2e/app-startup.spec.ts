import { openAppPage } from '../helpers/navigation';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('앱 시작·IPC·탐색·테마와 Electron 경계를 확인한다', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'llm-wiki-electron-'));
  // 빌드된 앱은 외부 개발 URL 환경값을 무시해야 합니다.
  const application = await electron
    .launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: 'https://example.invalid/',
      },
    })
    .catch(async (error: unknown) => {
      await rm(profile, { recursive: true, force: true });
      throw error;
    });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page).toHaveTitle('LLM Wiki');
    const navigation = page.getByRole('navigation', {
      name: '앱 탐색',
      exact: true,
    });
    await expect(navigation.getByRole('link')).toHaveText([
      'AI 작업',
      '지식 탐색',
      '위키 문서',
      '검토함',
    ]);
    const sidebar = page.getByRole('complementary', {
      name: '작업 탐색',
      exact: true,
    });
    expect((await sidebar.boundingBox())?.width).toBe(148);
    const bottom = page.getByRole('navigation', {
      name: '작업 공간 메뉴',
      exact: true,
    });
    await expect(bottom.getByRole('link')).toHaveText([
      '변경 이력',
      '작업 공간',
    ]);
    expect((await bottom.boundingBox())?.y).toBeGreaterThan(900);
    await page.getByRole('button', { name: '새 AI 요청', exact: true }).click();
    const request = page.getByRole('dialog', {
      name: '새 AI 요청',
      exact: true,
    });
    await expect(
      request.getByRole('link', { name: '질문·대화', exact: false }),
    ).toBeVisible();
    await expect(
      request.getByRole('link', { name: '새 분석 요청', exact: false }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(request).not.toBeVisible();

    await expect(
      page.getByRole('heading', { name: '지식이 쌓이는 나의 작업 공간' }),
    ).toBeVisible();
    expect(page.url()).toMatch(/^file:.*\/out\/renderer\/index\.html/);

    const cdp = await application.context().newCDPSession(page);
    const contextNames: string[] = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) =>
      contextNames.push(context.name),
    );
    await cdp.send('Runtime.enable');
    expect(contextNames).toContain('Electron Isolated Context');
    await cdp.detach();
    if (process.platform !== 'linux') {
      expect(
        await application.evaluate(({ app, BrowserWindow }) => {
          const pid =
            BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
          return app.getAppMetrics().find((metric) => metric.pid === pid)
            ?.sandboxed;
        }),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() => ({
        node: 'process' in window,
        require: 'require' in window,
      })),
    ).toEqual({ node: false, require: false });
    expect(
      await page.evaluate(() => Object.keys(window.wiki ?? {}).sort()),
    ).toEqual([
      'analysis',
      'analysisProposals',
      'app',
      'artifacts',
      'connection',
      'documents',
      'knowledge',
      'proposalExecution',
      'questionRuns',
      'recovery',
      'resultDrafts',
      'runtime',
      'sourceConversion',
      'sources',
      'workspace',
    ]);
    expect(
      await page.evaluate(() => Object.keys(window.wiki?.app ?? {})),
    ).toEqual(['getInfo']);
    expect(await page.evaluate(() => window.wiki?.app.getInfo())).toMatchObject(
      { ok: true, data: { name: 'LLM Wiki', version: '0.1.0' } },
    );
    const foreignWindowResult: unknown = await application.evaluate(
      async ({ app, BrowserWindow }) => {
        const probe = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: `${app.getAppPath()}/out/preload/index.cjs`,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        try {
          await probe.loadURL(
            BrowserWindow.getAllWindows()
              .find((window) => window !== probe)
              ?.webContents.getURL() ?? 'about:blank',
          );
          return await probe.webContents.executeJavaScript(
            'Promise.all([window.wiki.runtime.execute({operation:"read"}), window.wiki.recovery.execute({}), window.wiki.proposalExecution.start({}), window.wiki.app.getInfo(), window.wiki.documents.list({connectionId:"foreign",cursor:null,limit:20}), window.wiki.documents.content({connectionId:"foreign",document:"Guide-01.md"}), window.wiki.documents.sourcePreview({connectionId:"foreign"}), window.wiki.sources.chooseFile({connectionId:"foreign"}), window.wiki.sources.register({connectionId:"foreign"}), window.wiki.sources.receipt({connectionId:"foreign"}), window.wiki.sources.versions({connectionId:"foreign"}), window.wiki.sources.download({connectionId:"foreign"}), window.wiki.knowledge.read({connectionId:"foreign"}), window.wiki.workspace.execute({connectionId:"foreign"}), window.wiki.artifacts.chooseFile({connectionId:"foreign"}), window.wiki.artifacts.upload({connectionId:"foreign"}), window.wiki.artifacts.download({connectionId:"foreign"})])',
          );
        } finally {
          probe.destroy();
        }
      },
    );
    expect(foreignWindowResult).toMatchObject([
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
      { ok: false, error: { code: 'forbidden' } },
    ]);

    await openAppPage(page, '앱 정보');
    await expect(page).toHaveURL(/#\/about$/);
    await expect(
      page.getByRole('definition').filter({ hasText: '0.1.0' }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '앱 정보' })).toBeVisible();
    const themeButton = page.getByRole('button', { name: '어두운 테마' });
    await themeButton.focus();
    await page.keyboard.press('Enter');
    const lightThemeButton = page.getByRole('button', { name: '밝은 테마' });
    await expect(lightThemeButton).toBeFocused();
    await expect(lightThemeButton).toHaveCSS('outline-style', 'solid');
    await expect(page.locator('.app-shell')).toHaveAttribute(
      'data-wiki-theme',
      'dark',
    );
    await page.keyboard.press('Space');
    await expect(page.locator('.app-shell')).toHaveAttribute(
      'data-wiki-theme',
      'light',
    );
    await page.getByRole('button', { name: '어두운 테마' }).click();
    await expect(page.locator('.app-shell')).toHaveAttribute(
      'data-wiki-theme',
      'dark',
    );
    await page.getByRole('link', { name: '시작', exact: true }).click();
    await expect(page.locator('.app-shell')).toHaveAttribute(
      'data-wiki-theme',
      'dark',
    );
    await page.screenshot({ path: 'test-results/app-dark.png' });
    await page.getByRole('button', { name: '밝은 테마' }).click();
    await page.screenshot({ path: 'test-results/app-light.png' });

    const location = page.url();
    expect(
      await page.evaluate(
        () => window.open('https://example.invalid/') === null,
      ),
    ).toBe(true);
    expect(application.windows()).toHaveLength(1);
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const observation = { url: '', prevented: false };
      Reflect.set(contents, 'wikiTestNavigation', observation);
      contents.once('will-frame-navigate', (event) => {
        observation.url = event.url;
        observation.prevented = event.defaultPrevented;
      });
    });
    // 브라우저 기본 동작에서 발생하는 실제 탐색 요청을 확인합니다.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://example.invalid/';
      link.textContent = 'boundary check';
      document.body.append(link);
      link.click();
      link.remove();
    });
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          Reflect.get(
            BrowserWindow.getAllWindows()[0].webContents,
            'wikiTestNavigation',
          ),
        ),
      )
      .toEqual({ url: 'https://example.invalid/', prevented: true });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getURL(),
      ),
    ).toBe(location);
    expect(await page.evaluate(() => window.location.href)).toBe(location);
    // 차단된 탐색을 계속 대기하는 Playwright의 경로 추적과 실제 DOM을 구분합니다.
    expect(
      await page.evaluate(() => {
        const heading = document.querySelector('h1');
        return {
          text: heading?.textContent,
          visible: (heading?.getBoundingClientRect().height ?? 0) > 0,
        };
      }),
    ).toEqual({ text: '지식이 쌓이는나의 작업 공간', visible: true });
    const policy = await page.evaluate(() =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content'),
    );
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true });
  }
});
