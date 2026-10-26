import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { _electron as electron, expect, test } from '@playwright/test';

test('실제 API 연결·소속 선택·오류·권한 회수·비밀/이전 범위 보존', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'wiki-connection-ui-'));
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
  };
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/connection_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  server.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: server.stdout });
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const ready = Promise.race([
      once(lines, 'line').then((values) => {
        const line: unknown = values[0];
        if (typeof line !== 'string') throw new Error('시험 API 준비 오류');
        return JSON.parse(line);
      }),
      once(server, 'exit').then(() => {
        throw new Error(`시험 API 시작 실패: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify(tokens) + '\n');
    const details: unknown = await ready;
    if (
      typeof details !== 'object' ||
      !details ||
      !('port' in details) ||
      typeof details.port !== 'number' ||
      !('policy' in details) ||
      typeof details.policy !== 'string'
    )
      throw new Error('시험 API 준비 응답 오류');
    const base = `http://127.0.0.1:${details.port}`;
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${base}/fixture-stats`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    });
    let page = await application.firstWindow();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    let url = page.getByRole('textbox', { name: '서버 주소', exact: true });
    let token = page.getByLabel('개인 토큰');
    const connect = async (serverUrl: string, credential: string) => {
      await url.fill(serverUrl);
      await token.fill(credential);
      await page
        .getByRole('button', { name: '서버 연결 확인', exact: true })
        .click();
    };
    expect(
      await page.evaluate(
        (credential) =>
          window.wiki?.connection.connect({
            serverUrl: 'http://example.invalid',
            token: credential,
          }),
        tokens.alice,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_url' } });
    expect(
      await application.evaluate(async ({ BrowserWindow, app }) => {
        const original = BrowserWindow.getAllWindows()[0];
        const probe = new BrowserWindow({
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            preload: `${app.getAppPath()}/out/preload/index.cjs`,
          },
        });
        try {
          await probe.loadURL(original.webContents.getURL());
          return await probe.webContents.executeJavaScript(
            'window.wiki.connection.getState()',
          );
        } finally {
          probe.destroy();
        }
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // Zod 오류는 해당 입력에 연결되며 잘못된 입력으로 API 연결을 시작하지 않습니다.
    await page
      .getByRole('button', { name: '서버 연결 확인', exact: true })
      .click();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(token).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText('서버 주소를 입력해 주세요.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('개인 토큰을 입력해 주세요.', { exact: true }),
    ).toBeVisible();
    await connect('http://example.invalid', tokens.alice);
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(
      await page.evaluate(() => window.wiki?.connection.getState()),
    ).toMatchObject({
      ok: true,
      data: {
        status: 'disconnected',
        protection: { remembered: false, saved: false },
      },
    });

    await connect(base, 'invalid-token');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(token).toHaveValue('');
    expect(
      (await page.evaluate(() => window.wiki?.connection.getState()))?.ok,
    ).toBe(true);

    await connect(`${base}/proxy`, tokens.alice);
    await expect(
      page.getByRole('combobox', { name: '작업 공간', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    await expect(token).toHaveValue('');
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('beta');
    await page
      .getByRole('combobox', { name: '관점', exact: true })
      .selectOption('business');
    // 공간 변경 시 이전 관점 대신 새 공간의 기본 관점으로 폼 값을 함께 바꿉니다.
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('alpha');
    await expect(
      page.getByRole('combobox', { name: '관점', exact: true }),
    ).toHaveValue('all');
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('beta');
    await expect(
      page.getByRole('combobox', { name: '관점', exact: true }),
    ).toHaveValue('all');
    await page
      .getByRole('combobox', { name: '관점', exact: true })
      .selectOption('business');
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await expect(
      page.getByText('작업 공간이 선택되었습니다', { exact: true }),
    ).toBeVisible();
    let snapshot = await page.evaluate(() =>
      window.wiki?.connection.getState(),
    );
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        status: 'connected',
        userId: 'alice',
        selection: { tenant: 'beta', profile: 'business' },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(tokens.alice);
    await page.reload();
    await expect(
      page.getByText('작업 공간이 선택되었습니다', { exact: true }),
    ).toBeVisible();
    await expect(token).toHaveValue('');

    // API 응답 형식 오류가 토큰이나 원문 응답을 UI로 노출하지 않아야 합니다.
    await connect(`${base}/broken`, tokens.alice);
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(tokens.alice);
    snapshot = await page.evaluate(() => window.wiki?.connection.getState());
    expect(snapshot).toMatchObject({
      ok: true,
      data: { userId: 'alice', selection: { tenant: 'beta' } },
    });
    await connect(`${base}/redirect`, tokens.alice);
    await expect(page.getByRole('alert')).toBeVisible();
    const stats: unknown = await (await fetch(`${base}/fixture-stats`)).json();
    expect(stats).toMatchObject({ redirect_followed: 0 });

    // 같은 연결에서도 선택 직전 실제 정책을 다시 읽어 회수된 소속을 거부합니다.
    const policy: unknown = JSON.parse(await readFile(details.policy, 'utf8'));
    if (
      typeof policy !== 'object' ||
      !policy ||
      !('users' in policy) ||
      typeof policy.users !== 'object' ||
      !policy.users ||
      !('alice' in policy.users) ||
      typeof policy.users.alice !== 'object' ||
      !policy.users.alice ||
      !('memberships' in policy.users.alice) ||
      typeof policy.users.alice.memberships !== 'object' ||
      !policy.users.alice.memberships
    )
      throw new Error('시험 정책 오류');
    Reflect.deleteProperty(policy.users.alice.memberships, 'beta');
    await writeFile(details.policy, JSON.stringify(policy));
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('beta');
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await expect(page.getByRole('alert')).toBeVisible();
    snapshot = await page.evaluate(() => window.wiki?.connection.getState());
    expect(snapshot).toMatchObject({ ok: true, data: { selection: null } });

    await connect(base, tokens.bob);
    await expect(page.getByText('bob', { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('combobox', { name: '작업 공간', exact: true })
        .locator('option'),
    ).toHaveCount(1);
    await expect(
      page.getByRole('combobox', { name: '작업 공간', exact: true }),
    ).toHaveValue('beta');
    if (process.platform === 'darwin') {
      // 실제 macOS 보호 저장 → 프로세스 종료 → 시작 시 재검증과 선택 복원을 확인합니다.
      await page
        .getByRole('checkbox', {
          name: '이 PC에 연결을 보호 저장하고 다시 열 때 복원',
          exact: true,
        })
        .check();
      await connect(base, tokens.bob);
      await page
        .getByRole('button', { name: '작업 공간 선택', exact: true })
        .click();
      await expect(
        page.getByText('작업 공간이 선택되었습니다', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => window.wiki?.connection.getState()),
      ).toMatchObject({
        ok: true,
        data: {
          status: 'connected',
          userId: 'bob',
          protection: {
            saved: true,
            remembered: true,
            backend: 'macos_keychain',
          },
          selection: { tenant: 'beta' },
        },
      });
      await application.close();
      application = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${profile}`],
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(5000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByRole('link', { name: '서버 연결', exact: true }).click();
      url = page.getByRole('textbox', { name: '서버 주소', exact: true });
      token = page.getByLabel('개인 토큰');
      await expect(page.getByText('bob', { exact: true })).toBeVisible();
      await expect(token).toHaveValue('');
      expect(
        await page.evaluate(() => window.wiki?.connection.getState()),
      ).toMatchObject({
        ok: true,
        data: {
          status: 'connected',
          userId: 'bob',
          protection: { saved: true, remembered: true },
          selection: { tenant: 'beta' },
        },
      });
    }
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    // 복구 자료와 보호 자격 삭제가 끝난 실제 상태를 확인합니다.
    await expect
      .poll(async () => page.evaluate(() => window.wiki?.connection.getState()))
      .toMatchObject({
        ok: true,
        data: {
          status: 'disconnected',
          protection: { remembered: false, saved: false },
        },
      });
    await connect(base, tokens.none);
    await expect(
      page.getByText('소속된 작업 공간이 없습니다', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '작업 공간 선택', exact: true }),
    ).toHaveCount(0);
    await connect(`${base}/slow`, tokens.bob);
    await expect
      .poll(async () => {
        const value: unknown = await (
          await fetch(`${base}/fixture-stats`)
        ).json();
        return typeof value === 'object' && value && 'slow' in value
          ? value.slow
          : 0;
      })
      .toBe(1);
    await page.getByRole('button', { name: '연결 취소', exact: true }).click();
    expect(
      await page.evaluate(() => window.wiki?.connection.getState()),
    ).toMatchObject({
      ok: true,
      data: {
        status: 'disconnected',
        protection: { remembered: false, saved: false },
      },
    });
    await connect(base, tokens.alice);
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await expect(
      page.getByText('작업 공간이 선택되었습니다', { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/connection-screen.png' });
    if (!('token_sha256' in policy.users.alice))
      throw new Error('시험 사용자 오류');
    policy.users.alice.token_sha256 = randomBytes(32).toString('hex');
    await writeFile(details.policy, JSON.stringify(policy));
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(
      await page.evaluate(() => window.wiki?.connection.getState()),
    ).toMatchObject({
      ok: true,
      data: {
        status: 'disconnected',
        protection: { remembered: false, saved: false },
      },
    });
    expect(
      // Storage 객체 대신 키 목록으로 인증 정보가 남지 않았는지 확인합니다.
      await page.evaluate((): { local: string[]; session: string[] } => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      })),
    ).toEqual({ local: [], session: [] });
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    lines.close();
    await rm(profile, { recursive: true, force: true });
  }
});
