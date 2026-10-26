import { openAppPage } from '../helpers/navigation';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { z } from 'zod';
import {
  analysisJobSchema,
  parseAnalysisDetailResult,
} from '../../src/shared/contracts/analysis.contract';
import type { AnalysisJob } from '../../src/shared/contracts/analysis.contract';

const fixtureSchema = z.object({
  serverUrl: z.url(),
  root: z.string(),
  fakeCli: z.string(),
  modePath: z.string(),
  startedPath: z.string(),
});
const jobsSchema = z.object({
  data: z.object({ items: z.array(analysisJobSchema) }),
});
const startedSchema = z.object({ pid: z.number().int(), mode: z.string() });

/** 서버의 작업 목록을 조회할 뿐, 새 작업이나 AI 실행을 만들지 않습니다. */
async function jobs(serverUrl: string, token: string): Promise<AnalysisJob[]> {
  const response = await fetch(
    `${serverUrl}/api/v1/tenants/alpha/analysis-jobs`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  return jobsSchema.parse(value).data.items;
}

/** 같은 Electron 창에서 개인 인증과 허용된 작업 공간을 실제로 선택합니다. */
async function connect(
  page: Page,
  serverUrl: string,
  token: string,
): Promise<void> {
  await page.getByRole('link', { name: '서버 연결', exact: true }).click();
  await page
    .getByRole('textbox', { name: '서버 주소', exact: true })
    .fill(serverUrl);
  await page.getByLabel('개인 토큰').fill(token);
  await page
    .getByRole('button', { name: '서버 연결 확인', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: '작업 공간', exact: true })
    .selectOption('alpha');
  await page
    .getByRole('combobox', { name: '관점', exact: true })
    .selectOption('all');
  await page
    .getByRole('button', { name: '작업 공간 선택', exact: true })
    .click();
  await expect(
    page.getByText('작업 공간이 선택되었습니다', { exact: true }),
  ).toBeVisible();
  await openAppPage(page, '문서 목록');
}

/** 화면을 다시 여는 동작이 실행을 만들지 않는지 같은 진입점으로 검사합니다. */
async function openAnalysis(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^등록 원본 · Electron 분석 원본/ })
    .click();
  await page.getByRole('button', { name: '분석·결과', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '원본 분석·결과', exact: true }),
  ).toBeVisible();
}

/** 프로세스 ID는 가짜 AI가 이번 검사에서 기록한 값만 사용합니다. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('Electron 분석 실행·서버 저장 영수증·부분 실패 보존·명시 취소', async (): Promise<void> => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(join(tmpdir(), 'wiki-analysis-ui-'));
  const token = randomBytes(32).toString('hex');
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/analysis_server.py')],
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
          throw new Error('분석 시험 서버 준비 오류');
        return JSON.parse(values[0]);
      }),
      once(server, 'exit').then((): never => {
        throw new Error(`분석 시험 서버 시작 실패: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify({ token }) + '\n');
    const details = fixtureSchema.parse(await ready);
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: { ...process.env, WIKI_ANALYSIS_CODEX_CLI: details.fakeCli },
    });
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error): void => {
      errors.push(error.message);
    });
    await connect(page, details.serverUrl, token);
    await openAnalysis(page);
    const dialog = page.getByRole('dialog', {
      name: '원본 분석·결과',
      exact: true,
    });
    await dialog
      .getByRole('textbox', { name: '저장할 위키 경로', exact: true })
      .fill('target.md');
    await dialog
      .getByRole('button', { name: '분석 시작', exact: true })
      .click();
    try {
      await expect(
        dialog.getByText('서버 저장 완료', { exact: true }),
      ).toBeVisible({ timeout: 25_000 });
    } catch (error: unknown) {
      // 실패 단계만 시험 산출물에 보존하며 인증 토큰·헤더는 기록하지 않습니다.
      const current = await jobs(details.serverUrl, token);
      await test.info().attach('analysis-job-events', {
        body: JSON.stringify(
          current.map((job: AnalysisJob): unknown => ({
            jobId: job.job_id,
            state: job.state,
            status: job.reported_status,
            blockers: job.blockers,
            events: job.events,
          })),
        ),
        contentType: 'application/json',
      });
      throw error;
    }
    await expect(
      dialog
        .getByRole('list', { name: '분석 작업 목록' })
        .getByRole('button', { name: /target\.md/ }),
    ).toContainText('서버 저장 완료');
    await expect(
      dialog.getByText(
        '진단 의견은 클라이언트 보고 · 서버의 의미 정확도 인증·사람 승인 없음',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole('region', { name: '진단 보고', exact: true }),
    ).toHaveCount(2);
    await expect(
      dialog
        .getByText('모의 진단: 원문 조건을 별도로 대조해야 합니다.', {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        '모의 누락 의견: 업무 적용 범위의 별도 확인이 필요합니다.',
        { exact: true },
      ),
    ).toBeVisible();
    await dialog.getByText('항목별 의미 의견 1건', { exact: true }).click();
    await expect(
      dialog.getByText(
        '모의 진단: 실제 원문 줄과 제출 관계의 인용을 대조했습니다.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText('관계 · 1번째 항목 (배열 인덱스 0)', { exact: true }),
    ).toBeVisible();
    const firstJobs = await jobs(details.serverUrl, token);
    expect(firstJobs).toHaveLength(1);
    const first = firstJobs[0];
    if (!first) throw new Error('저장된 분석 작업을 확인하지 못했습니다.');
    expect(first.result_summary).toMatchObject({
      status: 'complete',
      saved_count: 2,
      required_count: 2,
    });
    // 공개 bridge도 서버에 남은 영수증을 다시 읽어야 하며 로컬 종료값을 대신 쓰지 않습니다.
    const receiptResult = parseAnalysisDetailResult(
      await page.evaluate(async (jobId: string): Promise<unknown> => {
        const connected = await window.wiki?.connection.getState();
        if (!connected?.ok || connected.data.status !== 'connected')
          throw new Error('시험 연결이 해제되었습니다.');
        return window.wiki?.analysis.read({
          connectionId: connected.data.connectionId,
          jobId,
        });
      }, first.job_id),
    );
    expect(receiptResult.ok).toBe(true);
    if (!receiptResult.ok) throw new Error(receiptResult.error.message);
    expect(receiptResult.data.receipts).toHaveLength(2);
    for (const receipt of receiptResult.data.receipts) {
      expect(receipt.saved).toBe(true);
      expect(receipt.receipt?.review_status).toBe('unreviewed');
      expect(receipt.receipt?.execution?.origin).toBe('client_reported');
      expect(receipt.validation_report?.semantic).toEqual({
        status: 'not_run',
        human_approval: false,
      });
    }
    expect(
      await readFile(join(details.root, 'data/alpha/wiki/target.md'), 'utf8'),
    ).toBe('모델은 센서를 사용한다.\n');
    // 수정 전 파일 전체가 남아야 합니다. 결과가 같다는 이유로 이력을 건너뛰지 않습니다.
    const historyFiles = await readdir(
      join(details.root, 'data/alpha/_history/target.md'),
    );
    expect(historyFiles).toHaveLength(1);
    const history = historyFiles[0];
    if (!history) throw new Error('수정 전 위키 이력을 확인하지 못했습니다.');
    expect(
      await readFile(
        join(details.root, 'data/alpha/_history/target.md', history),
        'utf8',
      ),
    ).toBe('수정 전 전체 위키 본문\n');
    await page.screenshot({
      path: 'test-results/source-analysis-complete.png',
      fullPage: true,
    });

    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await openAnalysis(page);
    await dialog
      .getByRole('button', { name: '현재 결과 새로고침', exact: true })
      .click();
    expect(await jobs(details.serverUrl, token)).toHaveLength(1);

    // 그래프 단계만 실패시켜도 앞서 저장한 위키를 다시 쓰거나 지우지 않아야 합니다.
    await writeFile(details.modePath, 'fail_graph', 'utf8');
    await dialog
      .getByRole('textbox', { name: '저장할 위키 경로', exact: true })
      .fill('partial.md');
    await dialog
      .getByRole('button', { name: '분석 시작', exact: true })
      .click();
    await expect(
      dialog.getByText('일부 결과만 저장됨', { exact: true }),
    ).toBeVisible({ timeout: 25_000 });
    const partial = (await jobs(details.serverUrl, token)).find(
      (job: AnalysisJob): boolean =>
        job.targets.some(
          (target: AnalysisJob['targets'][number]): boolean =>
            target.document === 'partial.md',
        ),
    );
    expect(partial?.result_summary).toMatchObject({
      status: 'partial',
      saved_count: 1,
      required_count: 2,
    });
    expect(
      await readFile(join(details.root, 'data/alpha/wiki/partial.md'), 'utf8'),
    ).toBe('모델은 센서를 사용한다.\n');

    // 실행 도중 취소는 서버 작업과 실제 자식 프로세스를 함께 멈춰야 합니다.
    await writeFile(details.modePath, 'wait', 'utf8');
    await dialog
      .getByRole('textbox', { name: '저장할 위키 경로', exact: true })
      .fill('cancel.md');
    await dialog
      .getByRole('button', { name: '분석 시작', exact: true })
      .click();
    let pid = 0;
    await expect
      .poll(
        async (): Promise<string> => {
          try {
            const value: unknown = JSON.parse(
              await readFile(details.startedPath, 'utf8'),
            );
            const started = startedSchema.parse(value);
            pid = started.pid;
            return started.mode;
          } catch {
            return '';
          }
        },
        { timeout: 15_000 },
      )
      .toBe('wait');
    await dialog
      .getByRole('button', { name: '분석 취소', exact: true })
      .click();
    // 단계가 진행되어 화면의 판본이 오래됐다면 자동 재전송하지 않습니다.
    // 사용자에게 표시된 충돌 안내를 확인한 뒤 최신 결과를 읽고 다시 명시 취소합니다.
    const conflict = dialog.getByText(
      '작업 기준이 변경되었습니다. 현재 상태를 새로 확인해 주세요.',
      { exact: true },
    );
    await expect
      .poll(
        async (): Promise<boolean> =>
          (await jobs(details.serverUrl, token)).some(
            (job: AnalysisJob): boolean =>
              job.targets.some(
                (target: AnalysisJob['targets'][number]): boolean =>
                  target.document === 'cancel.md',
              ) && job.state === 'cancelled',
          ) || (await conflict.isVisible()),
      )
      .toBe(true);
    if (await conflict.isVisible()) {
      await dialog
        .getByRole('button', { name: '현재 결과 새로고침', exact: true })
        .click();
      await dialog
        .getByRole('button', { name: '분석 취소', exact: true })
        .click();
    }
    await expect
      .poll(
        async (): Promise<string | undefined> =>
          (await jobs(details.serverUrl, token)).find(
            (job: AnalysisJob): boolean =>
              job.targets.some(
                (target: AnalysisJob['targets'][number]): boolean =>
                  target.document === 'cancel.md',
              ),
          )?.state,
      )
      .toBe('cancelled');
    await expect.poll((): boolean => isRunning(pid)).toBe(false);
    // 자식이 완전히 멈춘 뒤 이번 실행용 비밀 파일도 남지 않아야 합니다.
    await expect
      .poll(async (): Promise<string[]> => {
        const names = await readdir(join(profile, 'analysis'));
        return names.filter((name: string): boolean =>
          name.startsWith('auth-'),
        );
      })
      .toEqual([]);
    // 부분 저장된 같은 작업을 새 실행 화면에서 재개해 중복 생성·Wiki 재저장을 막습니다.
    await writeFile(details.modePath, 'success', 'utf8');
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await openAppPage(page, 'AI 작업 목록');
    await page
      .getByRole('complementary', { name: 'AI 작업 목록', exact: true })
      .getByRole('button', { name: /partial\.md/ })
      .click();
    await page
      .getByRole('button', { name: '기존 작업 실행·재개 확인', exact: true })
      .click();
    const resume = page.getByRole('dialog', {
      name: '기존 분석 작업 실행·재개',
      exact: true,
    });
    const resumeButton = resume.getByRole('button', {
      name: '확인한 기준으로 남은 단계 재개',
      exact: true,
    });
    await expect(resumeButton).toBeEnabled();
    const beforeResume = await jobs(details.serverUrl, token);
    await resumeButton.click();
    await expect(
      resume.getByText('서버 저장 완료', { exact: true }),
    ).toBeVisible({ timeout: 25000 });
    const afterResume = await jobs(details.serverUrl, token);
    expect(afterResume).toHaveLength(beforeResume.length);
    expect(
      afterResume.find(
        (job: AnalysisJob): boolean => job.job_id === partial?.job_id,
      )?.result_summary,
    ).toMatchObject({ status: 'complete', saved_count: 2, required_count: 2 });
    expect(
      await readdir(join(details.root, 'data/alpha/_history/partial.md')).catch(
        (): string[] => [],
      ),
    ).toEqual([]);
    expect(await page.locator('body').innerText()).not.toContain(token);
    const publicState = await page.evaluate(async (): Promise<unknown> =>
      window.wiki?.connection.getState(),
    );
    expect(JSON.stringify(publicState)).not.toContain(token);
    expect(errors).toEqual([]);
    expect(stderr).not.toContain(token);
  } finally {
    if (application) await application.close();
    lines.close();
    if (server.exitCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      await stopped;
    }
    await rm(profile, { recursive: true, force: true });
  }
});
