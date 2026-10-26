import { openAppPage } from '../helpers/navigation';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Dialog } from 'electron';
import { z } from 'zod';

type WorkspaceFixture = {
  page: Page;
  application: ElectronApplication;
  base: string;
  profile: string;
  errors: string[];
  restart: () => Promise<Page>;
  close: () => Promise<void>;
};

/** 운영 자료와 분리된 실제 API 서버·Electron 창을 준비합니다. */
async function openWorkspace(
  questionAi: boolean = false,
  protectConnection: boolean = false,
): Promise<WorkspaceFixture> {
  const profile = await mkdtemp(join(tmpdir(), 'wiki-workspace-ui-'));
  if (questionAi) {
    // 모델 출력만 합성하고 main → Python → 실제 질문 API/영수증은 제품 경로를 사용합니다.
    execFileSync(
      resolve('../.venv/bin/python'),
      [
        '-B',
        '-c',
        'from pathlib import Path; import sys; from app.tests.fixtures.question_server import fake_cli; fake_cli(Path(sys.argv[1]))',
        profile,
      ],
      { cwd: resolve('..') },
    );
  }
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
      env: {
        ...process.env,
        WIKI_CLIENT_ROOT: resolve('..'),
        WIKI_PYTHON: resolve('../.venv/bin/python'),
        ...(questionAi
          ? { WIKI_QUESTION_CODEX_CLI: join(profile, 'question-fake-codex') }
          : {}),
      },
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
    if (protectConnection)
      await page
        .getByRole('checkbox', { name: /이 PC에 연결을 보호 저장/ })
        .check();
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
      restart: async (): Promise<Page> => {
        const route = new URL(page.url()).hash;
        await application?.close();
        application = await electron.launch({
          args: [resolve('.'), `--user-data-dir=${profile}`],
          env: {
            ...process.env,
            WIKI_CLIENT_ROOT: resolve('..'),
            WIKI_PYTHON: resolve('../.venv/bin/python'),
            ...(questionAi
              ? {
                  WIKI_QUESTION_CODEX_CLI: join(profile, 'question-fake-codex'),
                }
              : {}),
          },
        });
        const restored = await application.firstWindow();
        await expect
          .poll(async () =>
            restored.evaluate(() => window.wiki?.connection.getState()),
          )
          .toMatchObject({
            ok: true,
            data: {
              status: 'connected',
              selection: { tenant: 'alpha', profile: 'business' },
            },
          });
        await restored.evaluate((hash: string): void => {
          window.location.hash = hash;
        }, route);
        return restored;
      },
      close: async (): Promise<void> => {
        if (errors.length > 0)
          await test.info().attach('renderer-errors', {
            body: JSON.stringify(errors),
            contentType: 'application/json',
          });
        await application?.close();
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

/** 버튼 조작으로만 실제 지식 검토·문서 저장·전체 이력 복원을 수행합니다. */
test('연결 지식·검토 보류·문서 연결·본문 비교 저장·과거 전체 본문 복원', async (): Promise<void> => {
  test.setTimeout(120000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    const catalogue = page.getByRole('list', {
      name: '문서 목록',
      exact: true,
    });
    await catalogue.getByRole('button', { name: /Guide-01\.md/ }).click();
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    await expect(
      reader.getByRole('article', { name: '위키 본문', exact: true }),
    ).toBeVisible();
    // 독립 문서·본문·지식 조회가 서로 취소되지 않고 같은 허용 범위에서 완료되어야 합니다.
    expect(
      await page.evaluate(async (): Promise<boolean> => {
        const bridge = window.wiki;
        if (!bridge) return false;
        const connection = await bridge.connection.getState();
        if (!connection.ok || connection.data.status !== 'connected')
          return false;
        const connectionId = connection.data.connectionId;
        const results = await Promise.all([
          bridge.knowledge.read({ connectionId, document: 'Guide-01.md' }),
          bridge.knowledge.read({ connectionId, document: 'Guide-02.md' }),
          bridge.documents.content({ connectionId, document: 'Guide-01.md' }),
        ]);
        return results.every((result: { ok: boolean }): boolean => result.ok);
      }),
    ).toBe(true);
    await reader.getByRole('tab', { name: '연결된 지식', exact: true }).click();
    const knowledge = page.getByRole('region', {
      name: '연결된 지식',
      exact: true,
    });
    await knowledge
      .getByRole('tab', { name: '현재 유효 지식', exact: true })
      .click();
    await expect(
      knowledge.getByRole('list', { name: '유효 지식 목록', exact: true }),
    ).toBeVisible();
    await knowledge.getByRole('tab', { name: /^원문 주장/ }).click();
    await knowledge
      .getByRole('list', { name: '원문 주장 목록', exact: true })
      .getByRole('button')
      .first()
      .click();
    await knowledge
      .getByRole('button', { name: '원문 대조·판단', exact: true })
      .click();
    const review = page.getByRole('dialog', {
      name: '원문 대조·전문가 판단',
      exact: true,
    });
    await review
      .getByRole('combobox', { name: '검토 결과', exact: true })
      .selectOption('defer');
    await review
      .getByRole('textbox', { name: '검토 이유', exact: true })
      .fill('모의 UI 검증: 원문 조건을 다시 대조할 때까지 보류');
    await review
      .getByRole('button', { name: '검토 결과 기록', exact: true })
      .click();
    await expect(review).toHaveCount(0);
    await expect(
      knowledge.getByText('보류', { exact: false }).first(),
    ).toBeVisible();
    await knowledge
      .getByRole('button', { name: '원문 대조·판단', exact: true })
      .click();
    await review.getByRole('tab', { name: '기록·되돌림', exact: true }).click();
    await review
      .getByRole('button', {
        name: /모의 UI 검증: 원문 조건을 다시 대조할 때까지 보류/,
      })
      .click();
    await review
      .getByRole('textbox', { name: '되돌림 이유', exact: true })
      .fill('모의 검증: 원문 보류를 새 이벤트로 되돌림');
    await review
      .getByRole('button', { name: '이 원문 검토 되돌림 기록', exact: true })
      .click();
    await expect(review).toHaveCount(0);
    await knowledge
      .getByRole('button', { name: '원문 대조·판단', exact: true })
      .click();
    await review
      .getByRole('tab', { name: '전문가 업무 판단', exact: true })
      .click();
    await review
      .getByRole('textbox', { name: '업무 판단 이유', exact: true })
      .fill('모의 검증: 현재 업무 관점에 한정한 별도 판단');
    await review
      .getByRole('button', { name: '업무 판단 기록', exact: true })
      .click();
    await expect(review).toHaveCount(0);
    await knowledge
      .getByRole('button', { name: '원문 대조·판단', exact: true })
      .click();
    await review.getByRole('tab', { name: '기록·되돌림', exact: true }).click();
    await review
      .getByRole('button', {
        name: /모의 검증: 현재 업무 관점에 한정한 별도 판단/,
      })
      .click();
    await review
      .getByRole('textbox', { name: '되돌림 이유', exact: true })
      .fill('모의 검증: 별도 판단을 새 이벤트로 되돌림');
    await review
      .getByRole('button', { name: '이 업무 판단 되돌림 기록', exact: true })
      .click();
    await expect(review).toHaveCount(0);
    await page.screenshot({ path: 'test-results-workspace/knowledge.png' });
    await reader.getByRole('tab', { name: '문서 연결', exact: true }).click();
    const connections = page.getByRole('region', {
      name: '문서 연결',
      exact: true,
    });
    await expect(
      connections.getByRole('list', { name: '문서 연결 목록', exact: true }),
    ).toBeVisible();
    await connections
      .getByRole('button', { name: '변경 영향 확인', exact: true })
      .click();
    await page.screenshot({ path: 'test-results-workspace/connections.png' });
    await reader.getByRole('tab', { name: '본문', exact: true }).click();
    await reader
      .getByRole('button', { name: '본문 편집', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: /^본문 (편집|변경 비교)$/,
    });
    const field = editor.getByRole('textbox', {
      name: '위키 본문',
      exact: true,
    });
    const original = await field.inputValue();
    await field.fill(original + '\n\nUI 통합 검증에서 추가한 전체 본문.\n');
    await editor
      .getByRole('button', { name: '변경 비교', exact: true })
      .click();
    // 동시 편집의 실제 저장으로 충돌을 만들고 원래 초안이 보존되는지 확인합니다.
    expect(
      await page.evaluate(async (): Promise<boolean> => {
        const bridge = window.wiki;
        if (!bridge) return false;
        const connection = await bridge.connection.getState();
        if (!connection.ok || connection.data.status !== 'connected')
          return false;
        const current = await bridge.documents.content({
          connectionId: connection.data.connectionId,
          document: 'Guide-01.md',
        });
        if (!current.ok) return false;
        const access = current.data.access;
        const result = await bridge.workspace.execute({
          connectionId: connection.data.connectionId,
          expectedScope: {
            userId: access.userId,
            tenant: access.tenant,
            profileId: access.profileId,
            policyRevision: access.policyRevision,
          },
          operation: 'saveDocument',
          input: {
            document: current.data.document,
            expected_revision: current.data.revision,
            content: current.data.content + '\n다른 편집자의 모의 동시 변경.\n',
          },
        });
        return result.ok;
      }),
    ).toBe(true);
    await editor
      .getByRole('button', { name: '본문 저장', exact: true })
      .click();
    await expect(
      editor.getByText('본문이 변경되었습니다', { exact: true }),
    ).toBeVisible();
    await expect(editor).toContainText('UI 통합 검증에서 추가한 전체 본문.');
    await editor
      .getByRole('button', { name: '현재 본문 확인', exact: true })
      .click();
    await editor
      .getByRole('button', {
        name: '대조한 현재 본문을 기준으로 계속 편집',
        exact: true,
      })
      .click();
    await field.fill(
      original +
        '\n다른 편집자의 모의 동시 변경.\n\nUI 통합 검증에서 추가한 전체 본문.\n',
    );
    await editor
      .getByRole('button', { name: '변경 비교', exact: true })
      .click();
    await editor
      .getByRole('button', { name: '본문 저장', exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(
      reader.getByRole('article', { name: '위키 본문', exact: true }),
    ).toContainText('UI 통합 검증에서 추가한 전체 본문.');
    await reader.getByRole('tab', { name: '버전·변경', exact: true }).click();
    const versions = page.getByRole('region', {
      name: '문서 버전·변경',
      exact: true,
    });
    await versions
      .getByRole('list', { name: '본문 판본 목록', exact: true })
      .getByRole('button', { name: '이 판본 보기', exact: true })
      .first()
      .click();
    await expect(
      versions.getByRole('region', {
        name: '과거·현재 본문 비교',
        exact: true,
      }),
    ).toContainText('UI 통합 검증에서 추가한 전체 본문.');
    await page.screenshot({ path: 'test-results-workspace/history.png' });
    await versions
      .getByRole('button', { name: '이 본문을 새 판본으로 복원', exact: true })
      .click();
    await reader.getByRole('tab', { name: '본문', exact: true }).click();
    await expect(
      reader.getByRole('article', { name: '위키 본문', exact: true }),
    ).not.toContainText('UI 통합 검증에서 추가한 전체 본문.');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 원본 새 판본은 이전 바이트를 보존하고 네이티브 저장 결과까지 확인합니다. */
test('원본 새 판본 등록·과거 판본 미리보기·원본 내려받기', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    await page
      .getByRole('combobox', { name: '자료 종류', exact: true })
      .selectOption('source');
    const catalogue = page.getByRole('list', {
      name: '문서 목록',
      exact: true,
    });
    await catalogue.getByRole('button').first().click();
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    const original = await reader
      .getByRole('article', { name: '원본 미리보기', exact: true })
      .innerText();
    await reader.getByRole('tab', { name: '버전·변경', exact: true }).click();
    await page
      .getByRole('button', { name: '새 원본 올리기', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: '새 원본 올리기',
      exact: true,
    });
    await dialog.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('# 새 판본 원본\n\n새 판본 전체 내용.\n');
    await dialog
      .getByRole('button', { name: '등록하고 미리보기', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      reader.getByRole('article', { name: '원본 미리보기', exact: true }),
    ).toContainText('새 판본 전체 내용.');
    await reader.getByRole('tab', { name: '버전·변경', exact: true }).click();
    const versions = page.getByRole('region', {
      name: '원본 판본 관리',
      exact: true,
    });
    await expect(
      versions.getByText('원본 파일 · 2개 판본', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: 'test-results-workspace/source-versions.png',
    });
    const download = join(fixture.profile, 'download.md');
    await fixture.application.evaluate(
      ({ dialog }: { dialog: Dialog }, path: string): void => {
        dialog.showSaveDialog = async (): Promise<{
          canceled: boolean;
          filePath: string;
        }> => ({ canceled: false, filePath: path });
      },
      download,
    );
    await versions
      .getByRole('button', { name: '원본 내려받기', exact: true })
      .last()
      .click();
    await expect
      .poll(async (): Promise<boolean> => {
        try {
          return (await readFile(download, 'utf8')).length > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await versions
      .getByRole('button', { name: '이 판본 미리보기', exact: true })
      .last()
      .click();
    await expect(
      reader.getByRole('article', { name: '원본 미리보기', exact: true }),
    ).toHaveText(original);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 저장 질문의 실제 근거가 답변·결과·사용자 대응 비교까지 이어지는지 확인합니다. */
test('개인 질문·외부 답변·결과 보관·명시 주장 비교·보류 이벤트', async (): Promise<void> => {
  test.setTimeout(120000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    await openAppPage(page, '질문·대화');
    await page.getByRole('button', { name: '새 대화', exact: true }).click();
    const title = page.getByRole('dialog', {
      name: '새 개인 대화',
      exact: true,
    });
    await title
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('모의 개인 대화 검증');
    await title
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await expect(title).toHaveCount(0);
    await page
      .getByRole('textbox', { name: '근거와 함께 보관할 질문', exact: true })
      .fill('상품의 업무 관점 조건은 무엇인가요?');
    await page
      .getByText('질문에 사용할 자료 선택 (문서 0/8 · 원본 0/4)', {
        exact: true,
      })
      .click();
    await page
      .getByRole('checkbox', { name: 'Guide-01.md', exact: true })
      .check();
    await page
      .getByRole('button', { name: '선택 근거 준비·확인', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '질문 기록 저장', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: '질문 기록 저장', exact: true })
      .click();
    await page
      .getByRole('tab', { name: '외부·직접 답변 보관', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: '답변할 저장 질문', exact: true })
      .selectOption({ index: 1 });
    await page
      .getByRole('textbox', { name: '답변 내용', exact: true })
      .fill('모의 직접 작성 답변: 상품의 실제 근거 조건을 확인했습니다.');
    await page
      .getByRole('button', { name: '외부·직접 답변 저장', exact: true })
      .click();
    await page
      .getByRole('button', { name: '결과 초안으로 보관', exact: true })
      .click();
    const saved = page.getByRole('dialog', {
      name: '답변을 결과 초안으로 보관',
      exact: true,
    });
    await saved
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('모의 근거 포함 결과');
    await saved
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await expect(saved).toHaveCount(0);
    await page.screenshot({ path: 'test-results-workspace/conversation.png' });
    await openAppPage(page, '결과물');
    await page
      .getByRole('complementary', { name: '개인 기록 목록', exact: true })
      .getByRole('button', { name: /모의 근거 포함 결과/ })
      .click();
    await expect(
      page
        .getByText(
          '모의 직접 작성 답변: 상품의 실제 근거 조건을 확인했습니다.',
          { exact: true },
        )
        .first(),
    ).toBeVisible();
    await openAppPage(page, '변경 비교');
    await page.getByRole('button', { name: '새 비교', exact: true }).click();
    await page
      .getByRole('textbox', { name: '비교 제목', exact: true })
      .fill('모의 명시 대응 비교');
    await page
      .getByRole('combobox', { name: '이전 저장 결과', exact: true })
      .selectOption({ index: 1 });
    await page
      .getByRole('button', { name: '동일 범위의 현재 기준 준비', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: '저장 당시 주장', exact: true })
      .selectOption({ index: 1 });
    await page
      .getByRole('combobox', { name: '이번에 준비한 주장', exact: true })
      .selectOption({ index: 1 });
    await page
      .getByRole('textbox', { name: '대응 이유', exact: true })
      .fill('모의 UI 검증: 같은 판본의 동일한 실제 주장을 명시 대조');
    await page
      .getByRole('button', { name: '선택한 대응 추가', exact: true })
      .click();
    await page
      .getByRole('button', { name: '대응 1개로 비교 저장', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '완료·보류 이유', exact: true })
      .fill('모의 검증: 실제 전문가 대조 전까지 보류');
    await page
      .getByRole('button', { name: '비교 완료 이벤트 기록', exact: true })
      .click();
    await expect(
      page
        .getByText('모의 검증: 실제 전문가 대조 전까지 보류', { exact: true })
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results-workspace/comparison.png' });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** main의 실제 파일 전송과 서버의 고정 추출·첨부 계보를 함께 검증합니다. */
test('전체 AI 작업 조회·추출 본문·첨부 내려받기·선택 파일 첨부', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    const seed = z
      .object({ extractionContent: z.string(), artifactSha256: z.string() })
      .parse(await (await fetch(`${fixture.base}/fixture-workspace`)).json());
    await openAppPage(page, 'AI 작업 목록');
    await page
      .getByRole('complementary', { name: 'AI 작업 목록', exact: true })
      .getByRole('button', { name: /Guide-01\.md/ })
      .click();
    await page
      .getByRole('button', { name: '추출 결과·첨부 자료 보기', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: '추출 결과·첨부 자료',
      exact: true,
    });
    await expect(
      dialog.getByRole('region', { name: '실제 추출 본문', exact: true }),
    ).toContainText(seed.extractionContent);
    const savedPath = join(fixture.profile, 'actual-artifact.bin');
    await fixture.application.evaluate(
      ({ dialog }: { dialog: Dialog }, path: string): void => {
        dialog.showSaveDialog = async (): Promise<{
          canceled: boolean;
          filePath: string;
        }> => ({ canceled: false, filePath: path });
      },
      savedPath,
    );
    await dialog
      .getByRole('button', { name: '첨부 파일 저장', exact: true })
      .first()
      .click();
    await expect
      .poll(async (): Promise<string> => {
        try {
          return createHash('sha256')
            .update(await readFile(savedPath))
            .digest('hex');
        } catch {
          return '';
        }
      })
      .toBe(seed.artifactSha256);
    const uploadPath = join(fixture.profile, 'new-artifact.bin');
    await writeFile(uploadPath, Buffer.from([0, 1, 2, 250, 255, 13, 10]));
    await fixture.application.evaluate(
      ({ dialog }: { dialog: Dialog }, path: string): void => {
        dialog.showOpenDialog = async (): Promise<{
          canceled: boolean;
          filePaths: string[];
        }> => ({ canceled: false, filePaths: [path] });
      },
      uploadPath,
    );
    await dialog
      .getByRole('button', { name: '첨부 파일 선택', exact: true })
      .click();
    await dialog
      .getByRole('checkbox', {
        name: '이 파일을 선택한 추출물에 첨부합니다.',
        exact: true,
      })
      .check();
    await dialog
      .getByRole('button', { name: '선택 파일 첨부', exact: true })
      .click();
    await expect(
      dialog.getByText('첨부 등록 완료', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '첨부 파일 저장', exact: true }),
    ).toHaveCount(2);
    await expect(
      dialog
        .getByRole('navigation', { name: '작업 추출 결과 목록', exact: true })
        .getByRole('button')
        .first(),
    ).toBeInViewport();
    await page.screenshot({
      path: 'test-results-workspace/extraction-artifacts.png',
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 후보 제안과 원문 검토·전문가 정책의 별도 원장을 실제 API로 검증합니다. */
test('조건·개념 대응 제안·보류·검토 되돌림·별도 정책·정책 되돌림', async (): Promise<void> => {
  test.setTimeout(120000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  /** 준비된 의존 판본으로만 명시 저장하고 실제 상세가 갱신될 때까지 확인합니다. */
  async function savePrepared(): Promise<void> {
    await page
      .getByRole('button', { name: '변경 내용 준비', exact: true })
      .click();
    await page
      .getByRole('button', { name: '준비한 변경 저장', exact: true })
      .click();
    await expect(
      page.getByRole('form', { name: '대응 변경 작성', exact: true }),
    ).toHaveCount(0);
  }
  try {
    await openAppPage(page, '조건·개념 대응');
    await page
      .getByRole('button', { name: '새 대응 제안', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '대응 문장', exact: true })
      .fill('모의 검증: 두 문서의 상품 조건을 검토할 대응 후보');
    for (const [side, name] of [
      ['조건 쪽', 'Guide-01.md'],
      ['개념 쪽', 'Guide-02.md'],
    ]) {
      await page
        .getByRole('textbox', { name: `${side} 문서 경로`, exact: true })
        .fill(name);
      await page
        .getByRole('button', { name: `${side} 현재 원문 읽기`, exact: true })
        .click();
      const quote =
        '카탈로그 현업 관점의 상품은 카탈로그센터의 P-100이며 배송센터의 P-100과 다른 실체다.';
      await page
        .getByRole('textbox', { name: `${side} 정확한 인용`, exact: true })
        .fill(quote);
      await page
        .getByRole('spinbutton', { name: `${side} 시작 줄`, exact: true })
        .fill('3');
      await page
        .getByRole('spinbutton', { name: `${side} 끝 줄`, exact: true })
        .fill('3');
    }
    await page
      .getByRole('textbox', { name: '연결 근거 설명', exact: true })
      .fill(
        '모의 검증: 양쪽 실제 인용의 조건을 대조할 후보이며 동일성을 확정하지 않음',
      );
    await page
      .getByRole('textbox', { name: '확인 질문 (한 줄에 하나)', exact: true })
      .fill('두 문서의 상품 조건이 같은 업무 범위인가요?');
    await page
      .getByRole('textbox', { name: '범위 1 이름', exact: true })
      .fill('업무 영역');
    await page
      .getByRole('textbox', { name: '판단 이유', exact: true })
      .fill('모의 UI 검증의 대응 후보 제안');
    await savePrepared();
    await expect(
      page.getByRole('button', { name: '보류', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '보류', exact: true }).click();
    await page
      .getByRole('textbox', { name: '판단 이유', exact: true })
      .fill('모의 검증: 실제 업무 범위를 대조하기 전 보류');
    await savePrepared();
    await page
      .getByRole('button', { name: '최근 원문 검토 되돌림', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '판단 이유', exact: true })
      .fill('모의 검증: 방금 기록한 보류 이벤트를 새 이벤트로 되돌림');
    await savePrepared();
    await page
      .getByRole('button', { name: '별도 전문가 판단', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '대응 문장', exact: true })
      .fill('모의 전문가 판단: 한정된 검증 업무 영역에서 대응을 적용');
    await page
      .getByRole('textbox', { name: '연결 근거 설명', exact: true })
      .fill('모의 전문가의 명시 판단이며 원문 인용으로 승격하지 않음');
    await page
      .getByRole('combobox', { name: '범위 1 상태', exact: true })
      .selectOption('specified');
    await page
      .getByRole('textbox', { name: '범위 1 값', exact: true })
      .fill('모의 검증 영역');
    await page
      .getByRole('textbox', { name: '범위 1 근거', exact: true })
      .fill('모의 전문가가 직접 명시한 업무 범위');
    await page
      .getByRole('combobox', { name: '적용 기간 상태', exact: true })
      .selectOption('unrestricted');
    await page
      .getByRole('textbox', { name: '기간 근거', exact: true })
      .fill('모의 검증에서 명시한 무기한 적용');
    await page
      .getByRole('textbox', { name: '판단 이유', exact: true })
      .fill('모의 UI 검증의 별도 전문가 판단');
    await savePrepared();
    await page.screenshot({
      path: 'test-results-workspace/correspondence.png',
    });
    await page
      .getByRole('button', { name: '이 업무 판단 되돌림', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '판단 이유', exact: true })
      .fill('모의 검증의 전문가 판단을 새 이벤트로 되돌림');
    await savePrepared();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 바이너리 원본은 본문으로 해석하지 않고 고정 바이트 그대로 보관·내려받습니다. */
test('PDF 원본 등록·변환 준비 안내·전체 바이너리 내려받기', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n%fixture\n'),
      Buffer.from([0, 255, 254, 13, 10]),
      Buffer.from('PDF binary sentinel\n%%EOF'),
    ]);
    const input = join(fixture.profile, 'actual-original.pdf');
    const output = join(fixture.profile, 'downloaded-original.pdf');
    await writeFile(input, bytes);
    await fixture.application.evaluate(
      (
        { dialog }: { dialog: Dialog },
        paths: { input: string; output: string },
      ): void => {
        dialog.showOpenDialog = async (): Promise<{
          canceled: boolean;
          filePaths: string[];
        }> => ({ canceled: false, filePaths: [paths.input] });
        dialog.showSaveDialog = async (): Promise<{
          canceled: boolean;
          filePath: string;
        }> => ({ canceled: false, filePath: paths.output });
      },
      { input, output },
    );
    await page.getByRole('button', { name: '원본 등록', exact: true }).click();
    const registration = page.getByRole('dialog', {
      name: '원본 등록',
      exact: true,
    });
    await registration
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('바이너리 PDF 검증');
    await registration
      .getByRole('button', { name: '파일 선택', exact: true })
      .click();
    await registration
      .getByRole('button', { name: '등록하고 미리보기', exact: true })
      .click();
    await expect(registration).toHaveCount(0);
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    await expect(
      reader.getByText('PDF 원본 보관 완료 · 문자·표 변환 준비 전', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(reader).not.toContainText('PDF binary sentinel');
    await expect(reader.locator('iframe, object, embed')).toHaveCount(0);
    await reader.getByRole('tab', { name: '버전·변경', exact: true }).click();
    await page
      .getByRole('button', { name: '원본 내려받기', exact: true })
      .click();
    await expect
      .poll(async (): Promise<string> => {
        try {
          return createHash('sha256')
            .update(await readFile(output))
            .digest('hex');
        } catch {
          return '';
        }
      })
      .toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 실제 문자 보고와 출처·문맥을 고정한 다중 문서 계획은 명시 인계까지만 수행합니다. */
test('문자 보고·분석 범위·다중 산출물·필수 문맥·검증 후 작업 인계', async (): Promise<void> => {
  test.setTimeout(120000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    const seed = z
      .object({ extractionContent: z.string() })
      .parse(await (await fetch(`${fixture.base}/fixture-workspace`)).json());
    await page
      .getByRole('combobox', { name: '자료 종류', exact: true })
      .selectOption('source');
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button')
      .first()
      .click();
    await page
      .getByRole('link', { name: '분석 범위·산출물 설정', exact: true })
      .click();
    const plan = page.getByRole('form', {
      name: '분석 범위·산출물 계획',
      exact: true,
    });
    await expect(plan).toBeVisible();
    await page.getByText('외부 변환 보고 입력·조회', { exact: true }).click();
    const conversion = page.getByRole('form', {
      name: '외부 변환 보고',
      exact: true,
    });
    await conversion
      .getByRole('textbox', { name: '단위 ID', exact: true })
      .fill('whole-original');
    await conversion
      .getByRole('textbox', { name: '실제 변환 문자', exact: true })
      .fill(seed.extractionContent);
    await conversion
      .getByRole('checkbox', {
        name: '보고한 범위에 미독 구간이 없습니다',
        exact: true,
      })
      .check();
    await conversion
      .getByRole('button', { name: '실제 변환 보고 기록', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', {
        name: '분석 계획 근거·인계',
        exact: true,
      }),
    ).toContainText('변환 보고');
    await page.getByText('외부 변환 보고 입력·조회', { exact: true }).click();
    await plan
      .getByRole('textbox', { name: '저장할 Wiki 경로', exact: true })
      .fill('Generated/Plan-summary.md');
    await plan
      .getByRole('textbox', { name: '문서 제목', exact: true })
      .fill('모의 계획 요약 문서');
    await plan
      .getByRole('textbox', { name: '문서 목적', exact: true })
      .fill('모의 UI 검증: 원본 전체 문자를 근거로 요약 문서를 준비');
    await plan
      .getByRole('button', { name: '만들 문서 추가', exact: true })
      .click();
    await plan
      .getByRole('textbox', { name: '저장할 Wiki 경로', exact: true })
      .nth(1)
      .fill('Generated/Plan-concepts.md');
    await plan
      .getByRole('textbox', { name: '문서 제목', exact: true })
      .nth(1)
      .fill('모의 계획 개념 문서');
    await plan
      .getByRole('textbox', { name: '문서 목적', exact: true })
      .nth(1)
      .fill('모의 UI 검증: 동일한 원본 전체에서 별도 목적의 개념 문서를 준비');
    await plan
      .getByRole('checkbox', { name: '기계 지식', exact: true })
      .nth(1)
      .check();
    await plan
      .getByRole('button', { name: '문맥 문서 추가', exact: true })
      .click();
    await plan
      .getByRole('combobox', { name: '문맥 Wiki', exact: true })
      .selectOption('Guide-02.md');
    await plan
      .getByRole('textbox', { name: '함께 읽는 이유', exact: true })
      .fill('모의 UI 검증: 정의와 예외의 실제 참고 문서');
    await plan
      .getByRole('checkbox', { name: '필수 문맥', exact: true })
      .check();
    await plan
      .getByRole('button', { name: '분석 계획 생성', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: '저장된 계획·선택 문자', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '현재 기준 서버 검증', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: '검증한 계획을 작업으로 인계',
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: '검증한 계획을 작업으로 인계', exact: true })
      .click();
    const receipt = page.getByRole('region', {
      name: '분석 계획 인계 결과',
      exact: true,
    });
    await expect(receipt).toContainText('Generated/Plan-summary.md');
    await expect(receipt).toContainText('Generated/Plan-concepts.md');
    await receipt
      .getByRole('button', { name: '이 작업 실행·재개 확인', exact: true })
      .first()
      .click();
    const execution = page.getByRole('dialog', {
      name: '기존 분석 작업 실행·재개',
      exact: true,
    });
    await expect(
      execution.getByRole('region', { name: '실행 기준 확인', exact: true }),
    ).toContainText('Generated/Plan-summary.md');
    await expect(
      execution.getByRole('button', { name: '확인한 작업 실행', exact: true }),
    ).toBeEnabled();
    await execution.getByRole('button', { name: '닫기', exact: true }).click();
    await page.screenshot({ path: 'test-results-workspace/analysis-plan.png' });
    await page
      .getByRole('link', { name: 'AI 작업 목록에서 확인', exact: true })
      .click();
    await expect(
      page
        .getByRole('complementary', { name: 'AI 작업 목록', exact: true })
        .getByRole('button', { name: /Generated\/Plan-summary\.md/ }),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 실제 Electron·Python·HTTP에서 합성 모델 답변이 개인 결과·편집 초안·Wiki로 이어집니다. */
test('통합 동선: 문서 질문 → 개인 AI 답변 → 결과 초안 → Wiki 명시 반영', async (): Promise<void> => {
  test.setTimeout(120000);
  const fixture = await openWorkspace(true, true);
  let page = fixture.page;
  try {
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button', { name: /Guide-01/ })
      .click();
    await page
      .getByRole('link', { name: '이 자료로 질문', exact: true })
      .click();
    await page.getByRole('button', { name: '새 대화', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: '새 개인 대화',
      exact: true,
    });
    await dialog
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('통합 질문 결과 검증');
    await dialog
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText('질문에 사용할 자료 선택 (문서 1/8 · 원본 0/4)', {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: '근거와 함께 보관할 질문', exact: true })
      .fill('이 문서의 조건은 무엇인가요?');
    await page
      .getByRole('button', { name: '선택 근거 준비·확인', exact: true })
      .click();
    await page
      .getByRole('button', { name: '질문 기록 저장', exact: true })
      .click();
    await expect
      .poll(async (): Promise<string> =>
        readFile(join(fixture.profile, 'question-count'), 'utf8'),
      )
      .toBe('0');
    await page
      .getByRole('button', { name: '이 질문 실행', exact: true })
      .click();
    const nextQuestion = page.getByRole('textbox', {
      name: '근거와 함께 보관할 질문',
      exact: true,
    });
    await nextQuestion.fill('답변을 기다리며 작성 중인 다음 질문');
    await page
      .getByRole('button', {
        name: '저장한 질문으로 개인 AI 실행',
        exact: true,
      })
      .click();
    await expect(
      page.getByText('합성 질문 답변입니다.', { exact: true }).first(),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(async (): Promise<string> =>
        readFile(join(fixture.profile, 'question-count'), 'utf8'),
      )
      .toBe('1');
    await expect(
      page.getByRole('article').filter({ hasText: '개인 AI 답변' }),
    ).toContainText('합성 질문 답변입니다.');
    await expect(nextQuestion).toHaveValue(
      '답변을 기다리며 작성 중인 다음 질문',
    );
    await page
      .getByRole('button', { name: '결과 초안으로 보관', exact: true })
      .click();
    const resultDialog = page.getByRole('dialog', {
      name: '답변을 결과 초안으로 보관',
      exact: true,
    });
    await resultDialog
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('통합 고정 근거 결과');
    await resultDialog
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await openAppPage(page, '결과물');
    await page
      .getByRole('complementary', { name: '개인 기록 목록', exact: true })
      .getByRole('button', { name: /통합 고정 근거 결과/ })
      .click();
    await page
      .getByRole('link', { name: '결과 초안 편집·Wiki 반영', exact: true })
      .click();
    await page
      .getByRole('button', { name: '이 저장 결과로 초안 만들기', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '편집할 Markdown 본문', exact: true })
      .fill('# 통합 반영 본문\n\n명시적으로 편집한 질문 결과입니다.');
    await expect(
      page.getByText('종료 후 복구용 보호 저장 완료', { exact: true }),
    ).toBeVisible();
    page = await fixture.restart();
    await expect(
      page.getByRole('textbox', { name: '편집할 Markdown 본문', exact: true }),
    ).toHaveValue('# 통합 반영 본문\n\n명시적으로 편집한 질문 결과입니다.');
    expect(
      await readFile(join(fixture.profile, 'question-count'), 'utf8'),
    ).toBe('1');
    await page
      .getByRole('button', { name: '개인 초안 저장', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '대상 Wiki 경로', exact: true })
      .fill('results/integrated-question.md');
    await page
      .getByRole('button', { name: '대상 본문 읽기·비교', exact: true })
      .click();
    await page
      .getByRole('checkbox', { name: /대상 본문과 전체 반영 내용을 비교/ })
      .check();
    await page
      .getByRole('button', { name: 'Wiki에 명시 반영', exact: true })
      .click();
    await expect(
      page.getByText('실제 반영 영수증', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('link', { name: '반영한 Wiki 열기', exact: true })
      .click();
    await expect(
      page.getByRole('article', { name: '위키 본문', exact: true }),
    ).toContainText('명시적으로 편집한 질문 결과입니다.');
    await expect(
      page.getByRole('article', { name: '위키 본문', exact: true }),
    ).toContainText('Guide-01.md');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 원본 보관과 자동 문자 보고를 실제 앱 탭에서 구별하고 같은 판본을 계획으로 잇습니다. */
test('통합 동선: 고정 원본 문자 변환 → 저장 보고 → 분석 계획', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    await page
      .getByRole('combobox', { name: '자료 종류', exact: true })
      .selectOption('source');
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button')
      .first()
      .click();
    await page.getByRole('tab', { name: '문자 변환', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '개인 PC 원본 변환', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: '이 PC에서 변환하고 보고 저장',
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel('실제 변환 문자와 원본 위치', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page
      .getByRole('link', { name: '분석 범위·산출물 설정', exact: true })
      .click();
    await expect(
      page.getByRole('form', { name: '분석 범위·산출물 계획', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: '이 변환 보고로 분석 범위 설정',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('complementary', {
        name: '분석 계획 근거·인계',
        exact: true,
      }),
    ).toContainText('변환 보고');
    expect(fixture.errors).toEqual([]);
  } catch (error: unknown) {
    await test.info().attach('conversion-ui-state', {
      body: await page
        .getByRole('region', { name: '개인 PC 원본 변환', exact: true })
        .innerText(),
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    await fixture.close();
  }
});

/** 바이너리 원본의 실제 변환 판본을 문서 대체 없이 개인 질문 근거로 전달합니다. */
test('통합 동선: DOCX 등록 → 변환 보고 → 원본만으로 질문·답변 저장', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace(true);
  const { page } = fixture;
  try {
    const input = join(fixture.profile, 'question-original.docx');
    execFileSync(resolve('../.venv/bin/python'), [
      '-B',
      '-c',
      'from docx import Document; import sys; d=Document(); d.add_paragraph("원본만으로 질문할 실제 DOCX 문자입니다."); d.save(sys.argv[1])',
      input,
    ]);
    await fixture.application.evaluate(
      ({ dialog }: { dialog: Dialog }, path: string): void => {
        dialog.showOpenDialog = async (): Promise<{
          canceled: boolean;
          filePaths: string[];
        }> => ({ canceled: false, filePaths: [path] });
      },
      input,
    );
    await page.getByRole('button', { name: '원본 등록', exact: true }).click();
    const registration = page.getByRole('dialog', {
      name: '원본 등록',
      exact: true,
    });
    await registration
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('질문 근거 DOCX');
    await registration
      .getByRole('button', { name: '파일 선택', exact: true })
      .click();
    await registration
      .getByRole('button', { name: '등록하고 미리보기', exact: true })
      .click();
    await expect(registration).toHaveCount(0);
    await page.getByRole('tab', { name: '문자 변환', exact: true }).click();
    await page
      .getByRole('button', {
        name: '이 PC에서 변환하고 보고 저장',
        exact: true,
      })
      .click();
    const question = page.getByRole('button', {
      name: '저장한 변환으로 질문',
      exact: true,
    });
    await expect(question).toBeEnabled({ timeout: 30000 });
    await question.click();
    expect(new URL(page.url()).hash).toContain('conversionRevision=');
    await page.getByRole('button', { name: '새 대화', exact: true }).click();
    const title = page.getByRole('dialog', {
      name: '새 개인 대화',
      exact: true,
    });
    await title
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('DOCX 원본만 사용한 질문');
    await title
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await expect(title).toHaveCount(0);
    await expect(
      page.getByText('질문에 사용할 자료 선택 (문서 0/8 · 원본 1/4)', {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: '근거와 함께 보관할 질문', exact: true })
      .fill('이 DOCX의 내용은 무엇인가요?');
    await page
      .getByRole('button', { name: '선택 근거 준비·확인', exact: true })
      .click();
    await page
      .getByRole('button', { name: '질문 기록 저장', exact: true })
      .click();
    await page
      .getByRole('button', { name: '이 질문 실행', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: '저장한 질문으로 개인 AI 실행',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('article').filter({ hasText: '개인 AI 답변' }),
    ).toContainText('합성 질문 답변입니다.', { timeout: 30000 });
    await expect(
      page.getByRole('article').filter({ hasText: '개인 AI 답변' }),
    ).toContainText('원본만으로 질문할 실제 DOCX 문자입니다.');
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

/** 저장 전 추출안은 개인 비교와 분리되어 원문 고정·검증·명시 적용을 거칩니다. */
test('통합 동선: 문서 → 전체 추출안 비교 → 검증 후 명시 적용', async (): Promise<void> => {
  test.setTimeout(90000);
  const fixture = await openWorkspace();
  const { page } = fixture;
  try {
    const submission = execFileSync(
      resolve('../.venv/bin/python'),
      [
        '-B',
        '-c',
        `import json
from core.tests.modules.test_ontology import ontology_v3_fixture
source,entities,relations,candidates,attributes=ontology_v3_fixture()
for collection in (relations,candidates,attributes):
 for claim in collection:
  claim['qualifiers']={'polarity':'positive','modality':'asserted','condition':None,'scope':None,'time':None,**claim.get('qualifiers',{})}
print(json.dumps(dict(schema_version=3,entities=entities,relations=relations,relation_candidates=candidates,attributes=attributes)))`,
      ],
      { cwd: resolve('..'), encoding: 'utf8' },
    );
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button', { name: /Guide-01/ })
      .click();
    await page
      .getByRole('link', { name: '추출안 비교·적용', exact: true })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Wiki 문서 경로', exact: true }),
    ).toHaveValue('Guide-01.md');
    await page
      .getByRole('button', { name: '전체 원문·이전 추출 고정', exact: true })
      .click();
    await page.getByText('전체 추출안 편집·명시 대응', { exact: true }).click();
    await page
      .getByRole('textbox', { name: '전체 추출 JSON', exact: true })
      .fill(submission);
    await page
      .getByRole('button', { name: '전체 추출안을 초안으로 제출', exact: true })
      .click();
    await page
      .getByRole('button', { name: '현재 기준·구조·인용 검증', exact: true })
      .click();
    await page
      .getByRole('checkbox', {
        name: '전체 후보·미발견·근거를 확인하고 새 그래프 적용을 요청합니다.',
        exact: true,
      })
      .check();
    await page
      .getByRole('button', {
        name: '검증한 전체 추출안 명시 적용',
        exact: true,
      })
      .click();
    await expect(
      page.getByText('그래프 저장 증거 확인', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('실제 요청 영수증·정리 경고·현재성', { exact: true }),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
