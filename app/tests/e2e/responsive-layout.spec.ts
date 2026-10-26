import { openAppPage } from '../helpers/navigation';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { z } from 'zod';

type WorkspaceFixture = {
  page: Page;
  application: ElectronApplication;
  base: string;
  profile: string;
  errors: string[];
  close: () => Promise<void>;
};

/** 운영 자료와 분리된 실제 API 서버·Electron 창을 준비합니다. */
async function openResponsiveWorkspace(): Promise<WorkspaceFixture> {
  const profile = await mkdtemp(join(tmpdir(), 'wiki-responsive-ui-'));
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
    workspace: true,
  };
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/connection_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
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
          throw new Error('시험 서버 준비 응답 오류');
        return JSON.parse(values[0]);
      }),
      once(server, 'exit').then((): never => {
        throw new Error(`시험 서버 시작 실패: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify(tokens) + '\n');
    const details = z.object({ port: z.number().int() }).parse(await ready);
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
      args: [
        resolve(process.env.WIKI_LAYOUT_ENTRY ?? '.'),
        `--user-data-dir=${profile}`,
      ],
    });
    const current = application;
    const page = await current.firstWindow();
    const initial = await current.evaluate(
      ({ BrowserWindow, screen }): boolean => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return false;
        const bounds = window.getBounds();
        const area = screen.getDisplayMatching(bounds).workArea;
        return (
          bounds.x >= area.x &&
          bounds.y >= area.y &&
          bounds.x + bounds.width <= area.x + area.width &&
          bounds.y + bounds.height <= area.y + area.height
        );
      },
    );
    expect(initial).toBe(true);
    await page.setViewportSize({ width: 1920, height: 1080 });
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error): void => {
      errors.push(error.message);
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
    return {
      page,
      application: current,
      base,
      profile,
      errors,
      close: async (): Promise<void> => {
        await current.close();
        lines.close();
        if (server.exitCode === null) {
          server.kill('SIGTERM');
          await once(server, 'exit');
        }
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    if (application) await application.close();
    lines.close();
    if (server.exitCode === null) server.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

/** 스크롤 안쪽 콘텐츠와 달리 공통 패널 자체는 뷰포트를 벗어나지 않아야 합니다. */
async function expectContained(_page: Page, target: Locator): Promise<void> {
  await expect
    .poll(async (): Promise<boolean> =>
      target.evaluate((element: HTMLElement): boolean => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.right <= innerWidth + 1 &&
          rect.bottom <= innerHeight + 1
        );
      }),
    )
    .toBe(true);
}

/** 실제 자료·입력과 패널 전환을 검증하며 넓은 화면의 기존 치수를 고정합니다. */
test('1920 디자인 보존·1280 공통 패널·낮은 창·초안·전체 탐색', async (): Promise<void> => {
  const testInfo = test.info();
  test.setTimeout(120000);
  const fixture = await openResponsiveWorkspace();
  const { page } = fixture;
  try {
    const layout = page.locator('[data-layout-density]');
    const index = page.locator('[data-workspace-pane="index"]');
    const content = page.locator('[data-workspace-pane="content"]');
    const inspector = page.locator('[data-workspace-pane="inspector"]');
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button', { name: /Guide-01.md/ })
      .click();
    await expect(
      page.getByRole('region', { name: '문서 영역', exact: true }),
    ).toContainText('Guide-01');
    await expect(layout).toHaveAttribute('data-layout-density', 'wide');
    expect((await index.boundingBox())?.width).toBe(316);
    expect((await inspector.boundingBox())?.width).toBe(334);
    expect((await index.boundingBox())?.height).toBe(970);
    expect((await page.locator('.app-sidebar').boundingBox())?.width).toBe(148);
    expect((await page.locator('.app-header').boundingBox())?.height).toBe(52);
    await page.screenshot({ path: testInfo.outputPath('documents-1920.png') });
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1280, height: 720 },
      { width: 1280, height: 640 },
    ]) {
      await page.setViewportSize(size);
      await expect(layout).toHaveAttribute(
        'data-layout-density',
        size.width === 1440 ? 'wide' : 'compact',
      );
      await expectContained(page, layout);
      await expectContained(page, content);
      if (size.width === 1280) {
        const controls = page.getByRole('group', { name: '작업 영역 패널' });
        await controls
          .locator('button[data-workspace-target="inspector"]')
          .click();
        await expect(inspector).toBeVisible();
        await expect(content).toBeHidden();
        await expectContained(page, inspector);
        await controls
          .locator('button[data-workspace-target="content"]')
          .click();
        await expect(content).toContainText('Guide-01');
        await controls.locator('button[data-workspace-target="index"]').click();
        await expect(index).toBeHidden();
        await controls.locator('button[data-workspace-target="index"]').click();
        await expect(index).toBeVisible();
      }
      await page.screenshot({
        path: testInfo.outputPath(`documents-${size.width}-${size.height}.png`),
      });
    }
    // 낮은 창의 실제 등록 폼: 스크롤로 마지막 입력과 제출 동작에 도달할 수 있습니다.
    await page.getByRole('button', { name: '원본 등록', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expectContained(page, dialog);
    await dialog.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('해상도 검사 초안');
    await dialog
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('보존할 원본 내용');
    await dialog
      .getByRole('button', { name: '등록하고 미리보기', exact: true })
      .scrollIntoViewIfNeeded();
    await expectContained(
      page,
      dialog.getByRole('button', { name: '등록하고 미리보기', exact: true }),
    );
    await page.screenshot({
      path: testInfo.outputPath('registration-1280-640.png'),
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const routes = [
      'AI 작업 목록',
      '분석 범위·산출물',
      '지식 탐색',
      '검토함',
      '변경 이력',
      '질문 근거 준비',
      '질문·대화',
      '결과물',
      '변경 비교',
      '조건·개념 대응',
    ];
    for (const name of routes) {
      await openAppPage(page, name);
      await expect(layout).toHaveAttribute('data-layout-density', 'compact');
      await expectContained(page, layout);
      await page
        .getByRole('group', { name: '작업 영역 패널' })
        .locator('button[data-workspace-target="content"]')
        .click();
      await expectContained(page, content);
      if (name === '분석 범위·산출물') {
        await page
          .getByRole('complementary', { name: '분석할 실제 자료' })
          .getByRole('button', { name: /^Guide-01.md/ })
          .click();
        await expect(
          page.getByRole('region', { name: '분석 계획 편집' }),
        ).toBeVisible();
        await expectContained(page, content);
      }
      await page.screenshot({
        path: testInfo.outputPath(
          `screen-${routes.indexOf(name)}-1280-640.png`,
        ),
      });
      const inspectorControl = page
        .getByRole('group', { name: '작업 영역 패널' })
        .locator('button[data-workspace-target="inspector"]');
      if (['검토함', '변경 이력', '질문 근거 준비'].includes(name)) {
        // 목록/상세 시안은 없는 세 번째 패널을 만들지 않습니다.
        await expect(inspectorControl).toHaveCount(0);
        await expectContained(page, index);
      } else {
        await inspectorControl.click();
        await expect(inspector).toBeVisible();
        await expectContained(page, inspector);
      }
      await page
        .getByRole('group', { name: '작업 영역 패널' })
        .locator('button[data-workspace-target="content"]')
        .click();
    }
    const documents = page.getByRole('textbox', {
      name: '검색할 위키 문서 (한 줄에 하나)',
      exact: true,
    });
    await documents.fill('Guide-01.md');
    await page.setViewportSize({ width: 1024, height: 540 });
    await expect(layout).toHaveAttribute('data-layout-density', 'single');
    // 너비 변경 중 포커스가 있던 목록 입력을 유지합니다.
    await expect(documents).toBeFocused();
    await expect(index).toBeVisible();
    for (const target of ['inspector', 'content', 'index']) {
      await page
        .getByRole('group', { name: '작업 영역 패널' })
        .locator(`button[data-workspace-target="${target}"]`)
        .click();
    }
    await expect(documents).toHaveValue('Guide-01.md');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(layout).toHaveAttribute('data-layout-density', 'wide');
    await expect(documents).toHaveValue('Guide-01.md');
    await expect(inspector).toBeVisible();
    // 테마 변경도 같은 레이아웃/초안을 보존합니다.
    await page
      .getByRole('button', { name: '어두운 테마', exact: true })
      .click();
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.screenshot({
      path: testInfo.outputPath('correspondences-dark-1280-640.png'),
    });
    await openAppPage(page, '앱 정보');
    await expect(
      page.getByRole('heading', { name: '앱 정보', exact: true }),
    ).toBeVisible();
    await expectContained(
      page,
      page.getByRole('link', { name: '작업 공간', exact: true }),
    );
    const externalScroll = await page.evaluate(
      (): boolean =>
        document.documentElement.scrollWidth > innerWidth ||
        document.documentElement.scrollHeight > innerHeight,
    );
    expect(externalScroll).toBe(false);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 초광폭에서도 읽기 폭과 지도 배율을 유지하고 좁은 창에는 내부 스크롤을 사용합니다. */
test('문서 읽기 폭·지도 배율 1280/3440 비교', async (): Promise<void> => {
  const fixture = await openResponsiveWorkspace();
  const { page } = fixture;
  const measurements: {
    viewport: number;
    documentWidth?: number;
    mapWidth?: number;
  }[] = [];
  try {
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button', { name: /Guide-01.md/ })
      .click();
    const body = page.getByRole('article', { name: '위키 본문', exact: true });
    for (const width of [1280, 3440]) {
      await page.setViewportSize({
        width,
        height: width === 1280 ? 720 : 1440,
      });
      await expect(body).toBeVisible();
      const box = await body.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(960);
      if (width === 3440) expect(box?.width).toBe(960);
      measurements.push({ viewport: width, documentWidth: box?.width });
      await page.screenshot({
        path: test.info().outputPath(`documents-${width}.png`),
      });
    }
    await openAppPage(page, '지식 탐색');
    await page
      .getByRole('button', { name: '자료 범위 선택', exact: true })
      .first()
      .click();
    const scope = page.getByRole('dialog', {
      name: '조회할 자료 선택',
      exact: true,
    });
    await scope
      .getByRole('checkbox', { name: 'Guide-01.md', exact: true })
      .check();
    await scope
      .getByRole('textbox', { name: '찾을 단어', exact: true })
      .fill('상품');
    await scope.getByRole('button', { name: '조회', exact: true }).click();
    await page
      .getByRole('list', { name: '조회 항목 목록' })
      .getByRole('button')
      .first()
      .click();
    const map = page.getByRole('region', { name: '조회한 개념 연결 지도' });
    const svg = map.locator('svg');
    for (const width of [1280, 3440]) {
      await page.setViewportSize({
        width,
        height: width === 1280 ? 720 : 1440,
      });
      await expect(map).toBeVisible();
      expect((await svg.boundingBox())?.width).toBe(1020);
      measurements.push({
        viewport: width,
        mapWidth: (await svg.boundingBox())?.width,
      });
      expect(
        await page.evaluate(
          (): boolean => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.screenshot({
        path: test.info().outputPath(`knowledge-${width}.png`),
      });
    }
    await map.getByRole('button', { name: '지도 확대', exact: true }).click();
    expect((await svg.boundingBox())?.width).toBe(1275);
    await map.getByRole('button', { name: '100%로 복원', exact: true }).click();
    expect((await svg.boundingBox())?.width).toBe(1020);
    await writeFile(
      test.info().outputPath('measurements.json'),
      JSON.stringify(measurements, null, 2),
    );
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
