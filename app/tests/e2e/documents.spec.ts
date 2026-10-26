import { openAppPage } from '../helpers/navigation';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ConnectionResult } from '../../src/shared/contracts/connection.contract';

/** 임시 서버의 준비 메시지도 외부 입력으로 검사합니다. */
function serverDetails(value: unknown): { port: number; policy: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('port' in value) ||
    typeof value.port !== 'number' ||
    !('policy' in value) ||
    typeof value.policy !== 'string'
  )
    throw new Error('문서 시험 서버 준비 오류');
  return { port: value.port, policy: value.policy };
}

/** 실제 연결 UI로 인증하고 선택 결과가 확인된 경우에만 목록으로 진입합니다. */
async function selectWorkspace(
  page: Page,
  tenant: string,
  profile: string,
): Promise<void> {
  await page
    .getByRole('combobox', { name: '작업 공간', exact: true })
    .selectOption(tenant);
  await page
    .getByRole('combobox', { name: '관점', exact: true })
    .selectOption(profile);
  await page
    .getByRole('button', { name: '작업 공간 선택', exact: true })
    .click();
  await expect(
    page.getByText('작업 공간이 선택되었습니다', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: '문서 목록 보기 →', exact: true })
    .click();
}

/** 대기 중 연결 변경 시험에서 실제 목록 요청의 시작을 확인합니다. */
async function documentRequestCount(base: string): Promise<number> {
  const stats: unknown = await (await fetch(`${base}/fixture-stats`)).json();
  if (
    typeof stats !== 'object' ||
    stats === null ||
    !('document_requests' in stats) ||
    !Array.isArray(stats.document_requests)
  ) {
    throw new Error('문서 시험 요청 기록 오류');
  }
  return stats.document_requests.length;
}

/** GET 요청만 하는 제품 목록과 임시 시험 서버 제어를 구분해 검증합니다. */
test('실제 문서 목록·원본·관점·페이지 이동·목록 변경·빈 목록·권한 회수', async (): Promise<void> => {
  const browserProfile = await mkdtemp(join(tmpdir(), 'wiki-document-ui-'));
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
    documents: true,
  };
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/connection_server.py')],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  server.stderr.on('data', (chunk: Buffer): void => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: server.stdout });
  let application: ElectronApplication | undefined;
  try {
    const ready = Promise.race([
      once(lines, 'line').then((values: unknown[]): unknown => {
        const line = values[0];
        if (typeof line !== 'string')
          throw new Error('문서 시험 서버 준비 오류');
        return JSON.parse(line);
      }),
      once(server, 'exit').then((): never => {
        throw new Error(`문서 시험 서버 시작 실패: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify(tokens) + '\n');
    const details = serverDetails(await ready);
    const base = `http://127.0.0.1:${details.port}`;
    await expect
      .poll(async (): Promise<number> => {
        try {
          return (await fetch(`${base}/fixture-stats`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${browserProfile}`],
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(5_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const errors: string[] = [];
    page.on('pageerror', (error: Error): void => {
      errors.push(error.message);
    });
    await openAppPage(page, '문서 목록');
    await expect(
      page.getByText('작업 공간을 먼저 선택해 주세요', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await page
      .getByRole('textbox', { name: '서버 주소', exact: true })
      .fill(`${base}/proxy`);
    await page.getByLabel('개인 토큰').fill(tokens.alice);
    await page
      .getByRole('button', { name: '서버 연결 확인', exact: true })
      .click();
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    await selectWorkspace(page, 'alpha', 'business');

    const catalogue = page.getByRole('list', {
      name: '문서 목록',
      exact: true,
    });
    const rows = catalogue.getByRole('button');
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    const context = page.getByRole('complementary', {
      name: '문서 정보',
      exact: true,
    });
    await expect(
      page.getByRole('heading', { name: '문서 목록', exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(20);
    await expect(
      catalogue.getByRole('button', { name: /등록 원본/ }),
    ).toBeVisible();
    await expect(
      catalogue.getByText('Guide-01.md', { exact: true }),
    ).toBeVisible();

    // 시안의 316 / 중앙 가변 / 334px와 패널별 스크롤을 실제 렌더링에서 고정합니다.
    const [leftBox, centerBox, rightBox] = await Promise.all([
      page
        .getByRole('complementary', { name: '저장된 자료', exact: true })
        .boundingBox(),
      reader.boundingBox(),
      context.boundingBox(),
    ]);
    if (!leftBox || !centerBox || !rightBox)
      throw new Error('3분할 패널을 확인할 수 없습니다.');
    expect(leftBox.width).toBe(316);
    expect(rightBox.width).toBe(334);
    expect(leftBox.x).toBe(148);
    expect(leftBox.y).toBe(110);
    expect(leftBox.height).toBe(970);
    expect(
      Math.abs(centerBox.x - leftBox.x - leftBox.width),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rightBox.x - centerBox.x - centerBox.width),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(leftBox.y - centerBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(centerBox.height - rightBox.height)).toBeLessThanOrEqual(1);
    expect(
      await page
        .locator('#main-content')
        .evaluate(
          (element: HTMLElement): boolean =>
            element.scrollHeight === element.clientHeight,
        ),
    ).toBe(true);
    expect(
      await catalogue.evaluate(
        (element: HTMLElement): boolean =>
          element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    const wikiRow = catalogue.getByRole('button', { name: /Guide-01\.md/ });
    await wikiRow.click();
    await expect(wikiRow).toHaveAttribute('aria-pressed', 'true');
    await expect(
      reader.getByRole('heading', { name: 'Guide-01.md', exact: true }),
    ).toBeVisible();
    await expect(
      context.getByText('원본 미연결', { exact: true }),
    ).toBeVisible();
    // 검색은 현재 페이지에만 적용하며 목록 API의 범위를 확대하지 않습니다.
    const search = page.getByRole('searchbox', {
      name: '현재 페이지 검색',
      exact: true,
    });
    const beforeFilterRequests = await documentRequestCount(base);
    await search.fill('Guide-01');
    await expect(rows).toHaveCount(1);
    await search.fill('Guide-21');
    await expect(rows).toHaveCount(0);
    await search.fill('');
    await expect(rows).toHaveCount(20);
    const kindFilter = page.getByRole('combobox', {
      name: '자료 종류',
      exact: true,
    });
    await kindFilter.selectOption('source');
    await expect(rows).toHaveCount(1);
    await kindFilter.selectOption('wiki');
    await expect(rows).toHaveCount(19);
    await kindFilter.selectOption('all');
    const folderFilter = page.getByRole('combobox', {
      name: '문서 폴더',
      exact: true,
    });
    await folderFilter.selectOption('/');
    await expect(rows).toHaveCount(19);
    await folderFilter.selectOption('');
    await expect(rows).toHaveCount(20);
    expect(await documentRequestCount(base)).toBe(beforeFilterRequests);
    await catalogue.getByRole('button', { name: /등록 원본/ }).click();
    await expect(
      reader.getByRole('heading', { name: '등록 원본', exact: true }),
    ).toBeVisible();
    await expect(context.getByText('원본 등록', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/documents-three-pane.png' });
    await page
      .getByRole('button', { name: '어두운 테마', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', { name: '저장된 자료', exact: true }),
    ).toHaveCSS('background-color', 'rgb(32, 34, 41)');
    await expect(
      catalogue.getByRole('button', { name: /등록 원본/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({
      path: 'test-results/documents-three-pane-dark.png',
    });
    await page.getByRole('button', { name: '밝은 테마', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '이전 페이지', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: '다음 페이지', exact: true })
      .click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('Guide-21.md', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '다음 페이지', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: '이전 페이지', exact: true })
      .click();
    await expect(rows).toHaveCount(20);

    // 커서 기준이 바뀌면 옛 페이지를 숨기고 첫 페이지를 명시적으로 다시 읽습니다.
    expect((await fetch(`${base}/fixture-change`, { method: 'POST' })).ok).toBe(
      true,
    );
    await page
      .getByRole('button', { name: '다음 페이지', exact: true })
      .click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(rows).toHaveCount(0);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(rows).toHaveCount(20);
    await page
      .getByRole('button', { name: '다음 페이지', exact: true })
      .click();
    await expect(rows).toHaveCount(3);
    await expect(page.getByText('Guide-22.md', { exact: true })).toBeVisible();

    // 잘못된 서버 본문에는 시험 비밀이 있어도 공개 오류로만 표시합니다.
    expect(
      (await fetch(`${base}/fixture-mode/broken`, { method: 'POST' })).ok,
    ).toBe(true);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(rows).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(tokens.alice);
    expect(
      (await fetch(`${base}/fixture-mode/normal`, { method: 'POST' })).ok,
    ).toBe(true);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(rows).toHaveCount(20);
    await page.screenshot({ path: 'test-results/documents-screen.png' });
    // 실제 목록 실행에 탐색 한도와 읽기 실패를 주입해 빈 성공과 부분 결과를 구분합니다.
    expect(
      (await fetch(`${base}/fixture-mode/partial`, { method: 'POST' })).ok,
    ).toBe(true);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(
      page.getByText('일부 조회 안내', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('서버의 조회 한도에 도달했습니다.', { exact: false }),
    ).toBeVisible();
    await page.getByText('읽지 못한 문서 확인', { exact: true }).click();
    await expect(page.getByText(/Guide-\d+\.md ·/).first()).toBeVisible();
    await expect(
      page.getByText('문서가 없습니다', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '다음 페이지', exact: true }),
    ).toBeDisabled();
    expect(
      (await fetch(`${base}/fixture-mode/normal`, { method: 'POST' })).ok,
    ).toBe(true);
    await page.reload();
    await expect(rows).toHaveCount(20);

    const connected = await page.evaluate(
      (): Promise<ConnectionResult> | undefined =>
        window.wiki?.connection.getState(),
    );
    if (!connected?.ok || connected.data.status !== 'connected')
      throw new Error('시험 연결 상태 오류');
    const connectionId = connected.data.connectionId;
    expect(
      await page.evaluate(async (id: string): Promise<unknown> => {
        if (!window.wiki) throw new Error('시험 bridge 없음');
        return window.wiki.documents.list({
          connectionId: id,
          limit: 20,
          cursor: 'invalid',
        });
      }, connectionId),
    ).toMatchObject({ ok: false, error: { code: 'invalid_cursor' } });

    // 조회가 진행되는 동안 연결을 해제해 늦은 응답이 예전 자료를 복구하지 못하게 합니다.
    expect(
      (await fetch(`${base}/fixture-mode/slow`, { method: 'POST' })).ok,
    ).toBe(true);
    const beforeSlow = await documentRequestCount(base);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect
      .poll((): Promise<number> => documentRequestCount(base))
      .toBeGreaterThan(beforeSlow);
    await page.evaluate((): Promise<ConnectionResult> | undefined =>
      window.wiki?.connection.disconnect(),
    );
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeVisible();
    expect(
      (await fetch(`${base}/fixture-mode/normal`, { method: 'POST' })).ok,
    ).toBe(true);
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await page
      .getByRole('textbox', { name: '서버 주소', exact: true })
      .fill(`${base}/proxy`);
    await page.getByLabel('개인 토큰').fill(tokens.alice);
    await page
      .getByRole('button', { name: '서버 연결 확인', exact: true })
      .click();
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    await selectWorkspace(page, 'beta', 'all');
    await expect(
      page.getByText('문서가 없습니다', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Guide-01.md', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await selectWorkspace(page, 'alpha', 'business');
    await expect(rows).toHaveCount(20);

    // 임시 정책에서 read를 회수해 같은 선택의 다음 요청도 실제 인가가 거부하는지 확인합니다.
    const policy: unknown = JSON.parse(await readFile(details.policy, 'utf8'));
    if (
      typeof policy !== 'object' ||
      policy === null ||
      !('users' in policy) ||
      typeof policy.users !== 'object' ||
      policy.users === null ||
      !('alice' in policy.users) ||
      typeof policy.users.alice !== 'object' ||
      policy.users.alice === null ||
      !('memberships' in policy.users.alice) ||
      typeof policy.users.alice.memberships !== 'object' ||
      policy.users.alice.memberships === null ||
      !('alpha' in policy.users.alice.memberships) ||
      typeof policy.users.alice.memberships.alpha !== 'object' ||
      policy.users.alice.memberships.alpha === null ||
      !('permissions' in policy.users.alice.memberships.alpha)
    )
      throw new Error('문서 시험 정책 오류');
    policy.users.alice.memberships.alpha.permissions = [];
    await writeFile(details.policy, JSON.stringify(policy));
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeVisible();
    expect(
      await page.evaluate((): Promise<ConnectionResult> | undefined =>
        window.wiki?.connection.getState(),
      ),
    ).toMatchObject({ ok: true, data: { selection: null } });
    const stats: unknown = await (await fetch(`${base}/fixture-stats`)).json();
    expect(stats).toMatchObject({
      document_requests: expect.arrayContaining([
        {
          path: '/api/v1/tenants/alpha/documents',
          query: expect.stringContaining('profile=business'),
        },
        {
          path: '/api/v1/tenants/beta/documents',
          query: expect.stringContaining('profile=all'),
        },
      ]),
    });
    if (typeof stats !== 'object' || stats === null || !('methods' in stats))
      throw new Error('문서 시험 요청 기록 오류');
    expect(stats.methods).toEqual(expect.arrayContaining(['GET']));
    expect(stats.methods).not.toContain('POST');
    expect(stats.methods).not.toContain('PUT');
    expect(stats.methods).not.toContain('DELETE');
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    lines.close();
    await rm(browserProfile, { recursive: true, force: true });
  }
});
