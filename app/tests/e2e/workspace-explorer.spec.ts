import { openAppPage } from '../helpers/navigation';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
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
async function openWorkspace(): Promise<WorkspaceFixture> {
  const profile = await mkdtemp(join(tmpdir(), 'wiki-explorer-ui-'));
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
      args: [resolve('.'), `--user-data-dir=${profile}`],
    });
    const current = application;
    const page = await current.firstWindow();
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

/** 시안의 개념 목록·선택 중심 지도·범위 초안과 읽기 거부를 실제 서버로 확인합니다. */
test('개념 선택 지도·범위 초안 유지·시안 패널·권한 회수', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page, base } = fixture;
  try {
    await page.getByRole('link', { name: '지식 탐색', exact: true }).click();
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
    await expect(scope).not.toBeVisible();
    const rows = page.getByRole('list', { name: '조회 항목 목록' });
    await expect(rows.getByRole('button').first()).toBeVisible();
    const left = await page
      .getByRole('complementary', { name: '조회 항목 탐색' })
      .boundingBox();
    const inspector = page.getByRole('complementary', {
      name: '선택 항목 근거',
    });
    expect(left?.width).toBe(280);
    expect((await inspector.boundingBox())?.width).toBe(390);
    expect(
      await page
        .locator('#main-content')
        .evaluate(
          (node: HTMLElement): boolean =>
            node.scrollHeight === node.clientHeight,
        ),
    ).toBe(true);
    await expect(
      inspector.getByRole('button', { name: '이 대상의 연결 조회' }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: '자료 범위 변경', exact: true })
      .first()
      .click();
    await expect(
      scope.getByRole('checkbox', { name: 'Guide-01.md', exact: true }),
    ).toBeChecked();
    await scope
      .getByRole('checkbox', { name: 'Guide-02.md', exact: true })
      .check();
    await scope.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(
      page.getByText('조회 범위가 변경되었습니다', { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByRole('button', { name: '이 대상의 연결 조회' }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: '자료 범위 변경', exact: true })
      .first()
      .click();
    await scope.getByRole('button', { name: '조회', exact: true }).click();
    await rows.getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    const map = page.getByRole('region', { name: '조회한 개념 연결 지도' });
    await expect(map).toBeVisible();
    const entity = map.getByRole('button', {
      name: '개체 근거 · Guide-01.md · 상품 · catalog',
      exact: true,
    });
    await entity.focus();
    await page.keyboard.press('Enter');
    await expect(entity).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector).toContainText('카탈로그 현업 관점');
    await map
      .getByRole('button', { name: /^관계 근거/ })
      .first()
      .click();
    await expect(inspector).toContainText('원문 근거');
    await expect(inspector.getByRole('link')).toContainText('Guide-01.md');
    await expect(
      inspector.locator('details').filter({ hasText: '판본과 출처 정보' }),
    ).not.toHaveAttribute('open');
    await map.getByRole('button', { name: '지도 확대', exact: true }).click();
    await expect(map).toContainText('125%');
    await map.getByRole('button', { name: '100%로 복원', exact: true }).click();
    await page.screenshot({
      path: 'test-results-explorer/knowledge-light.png',
    });
    await page
      .getByRole('button', { name: '어두운 테마', exact: true })
      .click();
    await expect(inspector).toHaveCSS('background-color', 'rgb(32, 34, 41)');
    await expect(
      page.getByRole('button', { name: '새 AI 요청', exact: true }),
    ).toHaveCSS('background-color', 'rgb(238, 240, 246)');
    await page.screenshot({ path: 'test-results-explorer/knowledge-dark.png' });
    expect(
      (await fetch(`${base}/fixture-workspace-mode/revoke`, { method: 'POST' }))
        .ok,
    ).toBe(true);
    await page
      .getByRole('button', { name: '자료 범위 변경', exact: true })
      .first()
      .click();
    await scope.getByRole('button', { name: '조회', exact: true }).click();
    await expect(
      page.getByText('조회 범위를 확인해 주세요', { exact: true }),
    ).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(inspector.getByRole('link')).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 파생 위키 없는 원본과 필수 문서만의 근거 준비도 실제 API가 지원합니다. */
test('원본만 선택한 질문 준비·전체 원문·필수 문서·선택 주장·범위 변경 안내', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    await openAppPage(page, '질문 근거 준비');
    await page
      .getByRole('button', { name: '자료 범위 선택', exact: true })
      .first()
      .click();
    const prepare = page.getByRole('button', {
      name: '질문 근거 준비',
      exact: true,
    });
    await prepare.click();
    await expect(page.getByRole('alert')).toContainText(
      '위키·필수 문서 또는 고정 원본',
    );
    const original = page.getByRole('checkbox', { name: /등록 원본/ }).first();
    await original.check();
    await page.screenshot({ path: 'test-results-explorer/scope-dialog.png' });
    await prepare.click();
    await expect(
      page.getByText('질문 근거 준비 완료', { exact: true }),
    ).toBeVisible();
    const rows = page.getByRole('list', { name: '조회 항목 목록' });
    await rows.getByRole('button').first().click();
    await expect(
      page.getByRole('complementary', { name: '선택 항목 근거' }),
    ).toContainText('조회한 원문 전체');
    await page.screenshot({
      path: 'test-results-explorer/source-only-question.png',
    });
    await page
      .getByRole('button', { name: '자료 범위 변경', exact: true })
      .first()
      .click();
    await original.uncheck();
    await page
      .getByRole('checkbox', { name: 'Guide-01.md', exact: true })
      .nth(1)
      .check();
    await page
      .getByRole('dialog', { name: '조회할 자료 선택', exact: true })
      .getByRole('button', { name: '닫기', exact: true })
      .click();
    await expect(
      page.getByText('조회 범위가 변경되었습니다', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '자료 범위 변경', exact: true })
      .first()
      .click();
    await page
      .getByRole('button', { name: '선택 문서의 현재 주장 확인', exact: true })
      .click();
    const claim = page
      .getByRole('checkbox', { name: /현재 판본 참조/ })
      .first();
    await expect(claim).toBeVisible();
    await claim.check();
    await prepare.click();
    await expect(
      page.getByText('질문 근거 준비 완료', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('조회 범위가 변경되었습니다', { exact: true }),
    ).toHaveCount(0);
    await rows
      .getByRole('button', { name: /^Guide-01.md/ })
      .first()
      .click();
    const source = page.getByRole('complementary', { name: '선택 항목 근거' });
    await expect(source).toContainText('카탈로그 현업 관점');
    await expect(source).toContainText('인기도는 확인하지 않았다.');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 조회한 주장에 명시 보류를 기록하고 같은 문서의 과거 이유를 확인합니다. */
test('검토함 현재 주장 대조·보류 저장·변경 이력의 기록 이유', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    await page.getByRole('link', { name: '검토함', exact: true }).click();
    await page
      .getByRole('button', { name: '자료 범위 선택', exact: true })
      .first()
      .click();
    await page
      .getByRole('checkbox', { name: 'Guide-01.md', exact: true })
      .check();
    await page
      .getByRole('button', { name: '검토 대상 조회', exact: true })
      .click();
    const rows = page.getByRole('list', { name: '조회 항목 목록' });
    await rows.getByRole('button').first().click();
    await page.screenshot({ path: 'test-results-explorer/review-light.png' });
    await page
      .getByRole('button', { name: '현재 원문과 대조해 검토', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: '원문 대조·전문가 판단',
      exact: true,
    });
    await dialog
      .getByRole('combobox', { name: '검토 결과', exact: true })
      .selectOption('defer');
    await dialog
      .getByRole('textbox', { name: '검토 이유', exact: true })
      .fill('모의 검증: 전체 원문 조건을 다시 확인할 때까지 보류');
    await dialog
      .getByRole('button', { name: '검토 결과 기록', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('link', { name: '변경 이력', exact: true }).click();
    await page
      .getByRole('button', { name: '자료 범위 선택', exact: true })
      .first()
      .click();
    await page
      .getByRole('checkbox', { name: 'Guide-01.md', exact: true })
      .check();
    await page
      .getByRole('button', { name: '변경 이력 조회', exact: true })
      .click();
    await rows
      .getByRole('button', { name: /전체 원문 조건을 다시 확인/ })
      .click();
    const inspector = page.getByRole('complementary', {
      name: '선택 항목 근거',
    });
    await expect(inspector).toContainText(
      '모의 검증: 전체 원문 조건을 다시 확인할 때까지 보류',
    );
    await expect(inspector).toContainText('alice');
    await page.screenshot({ path: 'test-results-explorer/review-history.png' });
    await page.setViewportSize({ width: 680, height: 800 });
    await page
      .getByRole('group', { name: '작업 영역 패널', exact: true })
      .getByRole('button', { name: '본문', exact: true })
      .click();
    await expect(
      inspector.getByRole('heading', { name: '기록 당시 변경' }),
    ).toBeVisible();
    expect(
      (
        await page
          .getByRole('region', { name: '조회 결과', exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThan(500);
    expect(
      await page
        .locator('#main-content')
        .evaluate(
          (node: HTMLElement): boolean =>
            node.scrollWidth === node.clientWidth &&
            node.scrollHeight === node.clientHeight,
        ),
    ).toBe(true);
    await page.screenshot({
      path: 'test-results-explorer/history-compact.png',
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
