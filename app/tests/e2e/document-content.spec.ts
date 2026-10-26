import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Request } from '@playwright/test';
import { z } from 'zod';
import type { ConnectionResult } from '../../src/shared/contracts/connection.contract';

const detailsSchema = z.object({ port: z.number().int(), policy: z.string() });
const statsSchema = z.object({
  content_requests: z.array(z.object({ path: z.string(), query: z.string() })),
  content_completed: z.array(z.string()),
  source_requests: z.array(z.object({ path: z.string(), query: z.string() })),
  source_completed: z.array(z.string()),
});
type ContentStats = z.infer<typeof statsSchema>;

/** 시험 서버의 요청·완료 기록도 타입 검사 뒤 읽습니다. */
async function contentStats(base: string): Promise<ContentStats> {
  const value: unknown = await (await fetch(`${base}/fixture-stats`)).json();
  return statsSchema.parse(value);
}

/** 본문 선택·실패·늦은 완료는 운영 자료 없이 실제 HTTP/인가로 검증합니다. */
test('위키 본문·원본 MD/TXT·20MiB·무결성·재조회·선택 경합·전송 중 권한 회수', async (): Promise<void> => {
  const profile = await mkdtemp(join(tmpdir(), 'wiki-content-ui-'));
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
    documents: true,
    sourcePreview: true,
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
        if (typeof values[0] !== 'string')
          throw new Error('본문 시험 서버 준비 오류');
        return JSON.parse(values[0]);
      }),
      once(server, 'exit').then((): never => {
        throw new Error(`본문 시험 서버 시작 실패: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify(tokens) + '\n');
    const details = detailsSchema.parse(await ready);
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
      args: [resolve('.'), `--user-data-dir=${profile}`],
    });
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    const externalRequests: string[] = [];
    page.on('pageerror', (error: Error): void => {
      errors.push(error.message);
    });
    page.on('request', (request: Request): void => {
      if (request.url().startsWith('https://example.invalid/'))
        externalRequests.push(request.url());
    });
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await page
      .getByRole('textbox', { name: '서버 주소', exact: true })
      .fill(`${base}/proxy`);
    await page.getByLabel('개인 토큰').fill(tokens.alice);
    await page
      .getByRole('button', { name: '서버 연결 확인', exact: true })
      .click();
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('alpha');
    await page
      .getByRole('combobox', { name: '관점', exact: true })
      .selectOption('business');
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await expect(
      page.getByText('작업 공간이 선택되었습니다', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('link', { name: '문서 목록 보기 →', exact: true })
      .click();
    const catalogue = page.getByRole('list', {
      name: '문서 목록',
      exact: true,
    });
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    const context = page.getByRole('complementary', {
      name: '문서 정보',
      exact: true,
    });
    const article = reader.getByRole('article', {
      name: '위키 본문',
      exact: true,
    });
    const first = catalogue.getByRole('button', { name: /Guide-01\.md/ });
    await expect(catalogue.getByRole('button')).toHaveCount(20);
    await first.click();
    await expect(
      article.getByRole('heading', { name: '문서 읽기 검증', exact: true }),
    ).toBeVisible();
    await expect(
      article.getByText('첫 번째 문서', { exact: true }),
    ).toBeVisible();
    await expect(
      article.getByRole('cell', { name: '읽기 전용', exact: true }),
    ).toBeVisible();
    await expect(article.getByRole('checkbox').first()).toBeChecked();
    await expect(article.getByRole('checkbox').first()).toBeDisabled();
    await expect(article.locator('pre')).toContainText(
      "const fixture = '본문 그대로';",
    );
    await expect(article.getByRole('link')).toHaveCount(0);
    await expect(article.locator('img')).toHaveCount(0);
    expect(await page.evaluate((): boolean => 'bodyUnsafe' in window)).toBe(
      false,
    );
    expect(externalRequests).toEqual([]);
    await context.getByText('판본 정보', { exact: true }).click();
    await expect(
      context.getByText('읽은 본문 판본', { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/document-content-screen.png' });

    // 빈 문자열은 조회 실패와 구분하고 긴 본문은 중앙에서만 스크롤합니다.
    await catalogue.getByRole('button', { name: /Guide-02\.md/ }).click();
    await expect(
      reader.getByText('본문이 비어 있습니다', { exact: true }),
    ).toBeVisible();
    await expect(article).toHaveCount(0);
    await catalogue.getByRole('button', { name: /Guide-03\.md/ }).click();
    await expect(
      article.getByRole('heading', { name: '긴 본문 검증', exact: true }),
    ).toBeVisible();
    expect(
      await reader
        .getByRole('region', { name: '문서 본문', exact: true })
        .evaluate(
          (element: HTMLElement): boolean =>
            element.scrollHeight > element.clientHeight,
        ),
    ).toBe(true);
    expect(
      await page
        .locator('#main-content')
        .evaluate(
          (element: HTMLElement): boolean =>
            element.scrollHeight === element.clientHeight,
        ),
    ).toBe(true);

    // 목록 판본을 바꿔치기하지 않고 지금 실제로 읽은 판본을 구분합니다.
    expect(
      (await fetch(`${base}/fixture-content-change`, { method: 'POST' })).ok,
    ).toBe(true);
    await catalogue.getByRole('button', { name: /Guide-04\.md/ }).click();
    await expect(
      article.getByRole('heading', { name: '바뀐 본문', exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByText('목록 이후 본문이 변경되었습니다', { exact: true }),
    ).toBeVisible();

    // 본문만 실패해도 목록은 유지하고 재조회로 현재 선택을 복구합니다.
    expect(
      (await fetch(`${base}/fixture-content-mode/missing`, { method: 'POST' }))
        .ok,
    ).toBe(true);
    await catalogue.getByRole('button', { name: /Guide-05\.md/ }).click();
    await expect(
      reader.getByText('문서를 찾을 수 없습니다', { exact: true }),
    ).toBeVisible();
    await expect(article).toHaveCount(0);
    expect(
      (await fetch(`${base}/fixture-content-mode/normal`, { method: 'POST' }))
        .ok,
    ).toBe(true);
    await reader
      .getByRole('button', { name: '본문 다시 불러오기', exact: true })
      .click();
    await expect(
      article.getByRole('heading', { name: 'Guide 5', exact: true }),
    ).toBeVisible();
    expect(
      (await fetch(`${base}/fixture-content-mode/broken`, { method: 'POST' }))
        .ok,
    ).toBe(true);
    await reader
      .getByRole('button', { name: '본문 다시 불러오기', exact: true })
      .click();
    await expect(
      reader.getByText('본문을 불러오지 못했습니다', { exact: true }),
    ).toBeVisible();
    await expect(article).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(tokens.alice);
    expect(
      (await fetch(`${base}/fixture-content-mode/normal`, { method: 'POST' }))
        .ok,
    ).toBe(true);

    // 느린 첫 번째 본문 뒤 다른 문서를 선택해도 늦은 결과가 덮어쓰지 않습니다.
    expect(
      (await fetch(`${base}/fixture-content-mode/slow`, { method: 'POST' })).ok,
    ).toBe(true);
    const before = await contentStats(base);
    await first.click();
    await expect
      .poll(
        async (): Promise<number> =>
          (await contentStats(base)).content_requests.length,
      )
      .toBeGreaterThan(before.content_requests.length);
    await expect(
      reader.getByText('본문을 불러오고 있습니다', { exact: true }),
    ).toBeVisible();
    await catalogue.getByRole('button', { name: /Guide-02\.md/ }).click();
    await expect(
      reader.getByText('본문이 비어 있습니다', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async (): Promise<number> =>
          (await contentStats(base)).content_completed.filter(
            (document: string): boolean => document === 'Guide-01.md',
          ).length,
      )
      .toBeGreaterThan(
        before.content_completed.filter(
          (document: string): boolean => document === 'Guide-01.md',
        ).length,
      );
    await expect(
      reader.getByText('본문이 비어 있습니다', { exact: true }),
    ).toBeVisible();
    await expect(article).toHaveCount(0);
    expect(
      (await fetch(`${base}/fixture-content-mode/normal`, { method: 'POST' }))
        .ok,
    ).toBe(true);
    await catalogue
      .getByRole('button', {
        name: /등록 원본 · 등록 원본 ·/,
      })
      .click();
    const original = reader.getByRole('article', {
      name: '원본 미리보기',
      exact: true,
    });
    await expect(
      original.getByRole('heading', {
        name: '원본 미리보기 검증',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      original.getByRole('cell', { name: '보존', exact: true }),
    ).toBeVisible();
    await expect(original.locator('img, script, a')).toHaveCount(0);
    expect(await page.evaluate((): boolean => 'sourceUnsafe' in window)).toBe(
      false,
    );
    expect(externalRequests).toEqual([]);
    await expect(article).toHaveCount(0);
    await page.screenshot({ path: 'test-results/source-preview-screen.png' });

    // 목록 뒤 새 판본이 등록돼도 선택했던 불변 판본의 원문을 유지합니다.
    expect(
      (await fetch(`${base}/fixture-source-version`, { method: 'POST' })).ok,
    ).toBe(true);
    await reader
      .getByRole('button', { name: '원본 다시 불러오기', exact: true })
      .click();
    await expect(
      original.getByRole('heading', {
        name: '원본 미리보기 검증',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      original.getByRole('heading', { name: '새 원본 판본', exact: true }),
    ).toHaveCount(0);

    await catalogue.getByRole('button', { name: /텍스트 원본/ }).click();
    await expect(original.locator('pre')).toBeVisible();
    expect(await original.locator('pre').textContent()).toBe(
      '\ufeff# 서식 없는 원본\r\n  공백\t유지 🌱\r\n<script>window.sourceUnsafe = true</script>\n',
    );
    await expect(original.getByRole('heading')).toHaveCount(0);
    await catalogue.getByRole('button', { name: /빈 원본/ }).click();
    await expect(
      reader.getByText('원본이 비어 있습니다', { exact: true }),
    ).toBeVisible();
    await expect(original).toHaveCount(0);

    // 원본은 Wiki 1 MiB/JSON 한도와 분리해 최대 20 MiB까지 온전히 전달합니다.
    expect(
      await page.evaluate(
        async (): Promise<{
          ok: boolean;
          length?: number;
          first?: string;
          last?: string;
        }> => {
          const state = await window.wiki?.connection.getState();
          if (!state?.ok || state.data.status !== 'connected')
            return { ok: false };
          const list = await window.wiki?.documents.list({
            connectionId: state.data.connectionId,
            cursor: null,
            limit: 50,
          });
          if (!list?.ok) return { ok: false };
          const item = list.data.items.find(
            (value: (typeof list.data.items)[number]): boolean =>
              value.kind === 'source' && value.title === '큰 원본',
          );
          if (!item || item.kind !== 'source') return { ok: false };
          const result = await window.wiki?.documents.sourcePreview({
            connectionId: state.data.connectionId,
            sourceId: item.sourceId,
            sourceVersion: item.sourceVersion,
            sourceSha256: item.sourceSha256,
            sizeBytes: item.sizeBytes,
            format: item.format,
          });
          if (!result?.ok || result.data.content === null) return { ok: false };
          return {
            ok: true,
            length: result.data.content.length,
            first: result.data.content[0],
            last: result.data.content.at(-1),
          };
        },
      ),
    ).toEqual({ ok: true, length: 20 * 1024 * 1024, first: 'x', last: 'x' });

    /** 실패 주입은 임시 서버에만 적용하며 제품 API의 GET 경로를 그대로 사용합니다. */
    async function sourceMode(mode: string): Promise<void> {
      expect(
        (await fetch(`${base}/fixture-source-mode/${mode}`, { method: 'POST' }))
          .ok,
      ).toBe(true);
    }
    await sourceMode('missing');
    await catalogue
      .getByRole('button', {
        name: /등록 원본 · 등록 원본 ·/,
      })
      .click();
    await expect(
      reader.getByText('문서를 찾을 수 없습니다', { exact: true }),
    ).toBeVisible();
    await expect(original).toHaveCount(0);
    await sourceMode('normal');
    await reader
      .getByRole('button', { name: '원본 다시 불러오기', exact: true })
      .click();
    await expect(
      original.getByRole('heading', { name: '원본 미리보기 검증' }),
    ).toBeVisible();
    for (const mode of ['corrupt', 'bytes', 'redirect']) {
      await sourceMode(mode);
      await reader
        .getByRole('button', { name: '원본 다시 불러오기', exact: true })
        .click();
      await expect(
        reader.getByText('원본을 불러오지 못했습니다', { exact: true }),
      ).toBeVisible();
      await expect(original).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(
        tokens.alice,
      );
    }
    await sourceMode('slow');
    const previous = await contentStats(base);
    await reader
      .getByRole('button', { name: '원본 다시 불러오기', exact: true })
      .click();
    await expect
      .poll(
        async (): Promise<number> =>
          (await contentStats(base)).source_requests.filter(
            (value: { path: string; query: string }): boolean =>
              value.path.endsWith('/file'),
          ).length,
      )
      .toBeGreaterThan(
        previous.source_requests.filter(
          (value: { path: string; query: string }): boolean =>
            value.path.endsWith('/file'),
        ).length,
      );
    await expect(
      reader.getByText('원본을 불러오고 있습니다', { exact: true }),
    ).toBeVisible();
    await first.click();
    await expect(
      article.getByRole('heading', { name: '문서 읽기 검증' }),
    ).toBeVisible();
    await expect
      .poll(
        async (): Promise<number> =>
          (await contentStats(base)).source_completed.length,
      )
      .toBeGreaterThan(previous.source_completed.length);
    await expect(original).toHaveCount(0);
    await expect(
      article.getByRole('heading', { name: '문서 읽기 검증' }),
    ).toBeVisible();
    await sourceMode('revoke');

    // 실제 파일 전송 중 권한 회수는 본문·현재 선택·이전 목록을 함께 무효화합니다.
    await catalogue
      .getByRole('button', {
        name: /등록 원본 · 등록 원본 ·/,
      })
      .click();
    await expect(catalogue.getByRole('button')).toHaveCount(0);
    await expect(article).toHaveCount(0);
    await expect(
      page.getByText('작업 공간을 먼저 선택해 주세요', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate((): Promise<ConnectionResult> | undefined =>
        window.wiki?.connection.getState(),
      ),
    ).toMatchObject({ ok: true, data: { selection: null } });
    const stats = await contentStats(base);
    expect(stats.content_requests).toEqual(
      expect.arrayContaining([
        {
          path: '/api/v1/tenants/alpha/documents/content',
          query: expect.stringContaining('profile=business'),
        },
      ]),
    );
    expect(
      stats.source_requests.every(
        (value: { path: string; query: string }): boolean =>
          value.query === 'profile=business',
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    lines.close();
    await rm(profile, { recursive: true, force: true });
  }
});
