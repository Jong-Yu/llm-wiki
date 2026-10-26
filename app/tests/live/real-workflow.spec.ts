import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import type { AnalysisDetail } from '../../src/shared/contracts/analysis.contract';
import type { QuestionDetail } from '../../src/shared/contracts/questionRuns.contract';
import { z } from 'zod';
import { openAppPage } from '../helpers/navigation';

/** 공개 원문 한 건을 실제 로그인 모델·격리 HTTP/MCP·Electron으로 처리합니다. */
test('공개 원문 실제 모델 전체 동선과 명시 검토·Wiki 반영·종료 복구', async (): Promise<void> => {
  const sourcePath = process.env.WIKI_LIVE_SOURCE;
  test.skip(
    !sourcePath,
    'WIKI_LIVE_SOURCE로 공개 원문을 명시한 경우에만 실제 모델을 호출합니다.',
  );
  if (!sourcePath) return;
  const source = await readFile(sourcePath, 'utf8');
  const profile = await mkdtemp(join(tmpdir(), 'ui11-live-electron-'));
  const token = randomBytes(32).toString('hex');
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/real_workflow_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: server.stdout });
  const milestones: string[] = [];
  /** 모델 대기 중에도 완료한 실제 단계를 즉시 기록합니다. */
  function mark(value: string): void {
    milestones.push(value);
    process.stdout.write(`live: ${value}\n`);
  }
  let application: ElectronApplication | null = null;
  let serverUrl = '';
  try {
    const ready = once(lines, 'line');
    server.stdin.end(JSON.stringify({ token }) + '\n');
    const values: unknown[] = await ready;
    const details = z
      .object({ serverUrl: z.string(), root: z.string() })
      .parse(JSON.parse(z.string().parse(values[0])));
    serverUrl = details.serverUrl;
    const environment = {
      ...process.env,
      WIKI_CLIENT_ROOT: resolve('..'),
      WIKI_PYTHON: resolve('../.venv/bin/python'),
    };
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: environment,
    });
    let page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await page
      .getByRole('textbox', { name: '서버 주소', exact: true })
      .fill(serverUrl);
    await page.getByLabel('개인 토큰').fill(token);
    await page
      .getByRole('checkbox', { name: /이 PC에 연결을 보호 저장/ })
      .check();
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
    await openAppPage(page, '문서 목록');
    await page.getByRole('button', { name: '원본 등록', exact: true }).click();
    const registration = page.getByRole('dialog', {
      name: '원본 등록',
      exact: true,
    });
    await registration
      .getByRole('tab', { name: '직접 입력', exact: true })
      .click();
    await registration
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('RFC 9111 공개 원문');
    await registration
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill(source);
    await registration
      .getByRole('button', { name: '등록하고 미리보기', exact: true })
      .click();
    await expect(registration).not.toBeVisible();
    mark('source_registered_in_electron');
    await page.getByRole('tab', { name: '문자 변환', exact: true }).click();
    await page
      .getByRole('button', {
        name: '이 PC에서 변환하고 보고 저장',
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel('실제 변환 문자와 원본 위치', { exact: true }),
    ).toBeVisible({
      timeout: 40000,
    });
    mark('conversion_saved_real_worker');
    await page.getByRole('button', { name: '분석·결과', exact: true }).click();
    const analysis = page.getByRole('dialog', {
      name: '원본 분석·결과',
      exact: true,
    });
    await analysis
      .getByRole('textbox', { name: '저장할 위키 경로', exact: true })
      .fill('rfc9111-live.md');
    await analysis
      .getByRole('button', { name: '분석 시작', exact: true })
      .click();
    let lastAnalysisState = '';
    let analysisDetail: AnalysisDetail | null = null;
    await expect
      .poll(
        async (): Promise<boolean> => {
          const detail = await page.evaluate(
            async (): Promise<AnalysisDetail | null> => {
              const bridge = window.wiki;
              if (!bridge) return null;
              const connection = await bridge.connection.getState();
              if (!connection.ok || connection.data.status !== 'connected')
                return null;
              const connectionId = connection.data.connectionId;
              const jobs = await bridge.analysis.list({
                connectionId,
                sourceId: null,
                cursor: null,
              });
              if (!jobs.ok) return null;
              const job = jobs.data.items.find((item) =>
                item.targets.some(
                  (target) => target.document === 'rfc9111-live.md',
                ),
              );
              if (!job) return null;
              const result = await bridge.analysis.read({
                connectionId,
                jobId: job.job_id,
              });
              return result.ok ? result.data : null;
            },
          );
          analysisDetail = detail;
          if (!detail) return false;
          const state = `${detail.local.status}/${detail.job.result_summary.status}/${detail.job.result_summary.saved_count}`;
          if (state !== lastAnalysisState) {
            process.stdout.write(`live analysis: ${state}\n`);
            lastAnalysisState = state;
          }
          return (
            detail.job.result_summary.status === 'complete' ||
            ['failed', 'stopped'].includes(detail.local.status)
          );
        },
        { timeout: 1_850_000, intervals: [2000] },
      )
      .toBe(true);
    await writeFile(
      test.info().outputPath('initial-analysis.json'),
      JSON.stringify(analysisDetail, null, 2),
    );
    await expect(
      analysis.getByText('서버 저장 완료', { exact: true }),
    ).toBeVisible();
    mark('real_model_wiki_and_graph_saved');
    await page.keyboard.press('Escape');
    await page.evaluate((): void => {
      window.location.hash = '/analysis-proposals?document=rfc9111-live.md';
    });
    await page
      .getByRole('button', { name: '전체 원문·이전 추출 고정', exact: true })
      .click();
    await page
      .getByRole('checkbox', {
        name: '새 후보의 별도 AI 의미 검사도 실행',
        exact: true,
      })
      .check();
    await page
      .getByRole('button', { name: '명시 AI 재추출 실행', exact: true })
      .click();
    const execution = page.getByRole('region', {
      name: '개인 AI 재추출',
      exact: true,
    });
    await expect(execution.locator('p[role="status"]')).toContainText(
      /개인 실행 종료|개인 실행 실패/,
      {
        timeout: 1_850_000,
      },
    );
    const executionRecord = await execution.locator('pre').last().textContent();
    await writeFile(
      test.info().outputPath('proposal-execution.json'),
      executionRecord || '{}',
    );
    // 별도 검사 오류도 실제 결과로 기록하며 후보 저장 성공과 구분합니다.
    mark('real_candidate_execution_with_separate_check_requested');
    await page
      .getByRole('button', {
        name: '현재 후보 조회·이전 결과와 비교',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: '대조한 서버 후보로 새 편집 시작',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', { name: '현재 기준·구조·인용 검증', exact: true })
      .click();
    await page
      .getByRole('checkbox', { name: /전체 후보·미발견·근거를 확인/ })
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
    mark('explicit_candidate_apply_test_action');
    await openAppPage(page, '문서 목록');
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button', { name: /^위키 · rfc9111-live\.md/ })
      .click();
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    await reader.getByRole('tab', { name: '연결된 지식', exact: true }).click();
    const knowledge = page.getByRole('region', {
      name: '연결된 지식',
      exact: true,
    });
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
      .fill(
        '자동화된 명시 행동 시험: 실제 전문가 승인이 아니며 의미 정확도 판단을 보류합니다.',
      );
    await review
      .getByRole('button', { name: '검토 결과 기록', exact: true })
      .click();
    await expect(review).not.toBeVisible();
    mark('explicit_human_review_ui_test_defer_not_approval');
    await page
      .getByRole('link', { name: '이 자료로 질문', exact: true })
      .click();
    await page.getByRole('button', { name: '새 대화', exact: true }).click();
    const conversation = page.getByRole('dialog', {
      name: '새 개인 대화',
      exact: true,
    });
    await conversation
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('RFC 실제 모델 질문');
    await conversation
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '근거와 함께 보관할 질문', exact: true })
      .fill(
        'What conditions allow a cache to generate a stale response? Cite the source and preserve the exceptions.',
      );
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
    let questionDetail: QuestionDetail | null = null;
    await expect
      .poll(
        async (): Promise<boolean> => {
          questionDetail = await page.evaluate(
            async (): Promise<QuestionDetail | null> => {
              const bridge = window.wiki;
              if (!bridge) return null;
              const connection = await bridge.connection.getState();
              if (
                !connection.ok ||
                connection.data.status !== 'connected' ||
                !connection.data.selection
              )
                return null;
              const scope = {
                connectionId: connection.data.connectionId,
                expectedScope: {
                  userId: connection.data.userId,
                  tenant: connection.data.selection.tenant,
                  profileId: connection.data.selection.profile,
                  policyRevision: connection.data.policyRevision,
                },
              };
              const runs = await bridge.questionRuns.list({
                ...scope,
                cursor: null,
              });
              if (!runs.ok || !runs.data.items[0]) return null;
              const result = await bridge.questionRuns.read({
                ...scope,
                questionRunId: runs.data.items[0].id,
              });
              return result.ok ? result.data : null;
            },
          );
          return (
            questionDetail !== null &&
            (['complete', 'failed', 'cancelled'].includes(
              questionDetail.status,
            ) ||
              questionDetail.local.status === 'failed')
          );
        },
        { timeout: 950000, intervals: [2000] },
      )
      .toBe(true);
    await writeFile(
      test.info().outputPath('question-detail.json'),
      JSON.stringify(questionDetail, null, 2),
    );
    expect(questionDetail).toMatchObject({ status: 'complete' });
    await expect(
      page.getByRole('button', { name: '결과 초안으로 보관', exact: true }),
    ).toBeEnabled();
    mark('real_model_question_answer_saved');
    await page
      .getByRole('button', { name: '결과 초안으로 보관', exact: true })
      .click();
    const savedResult = page.getByRole('dialog', {
      name: '답변을 결과 초안으로 보관',
      exact: true,
    });
    await savedResult
      .getByRole('textbox', { name: '제목', exact: true })
      .fill('RFC 실제 질문 결과');
    await savedResult
      .getByRole('button', { name: '개인 기록 저장', exact: true })
      .click();
    await openAppPage(page, '결과물');
    await page
      .getByRole('complementary', { name: '개인 기록 목록', exact: true })
      .getByRole('button', { name: /RFC 실제 질문 결과/ })
      .click();
    await page
      .getByRole('link', { name: '결과 초안 편집·Wiki 반영', exact: true })
      .click();
    await page
      .getByRole('button', { name: '이 저장 결과로 초안 만들기', exact: true })
      .click();
    const editor = page.getByRole('textbox', {
      name: '편집할 Markdown 본문',
      exact: true,
    });
    const body = await editor.inputValue();
    expect(body.length).toBeGreaterThan(20);
    await editor.fill(
      `${body}\n\n실제 모델 통합 시험 결과입니다. 사람의 의미 승인으로 해석하지 않습니다.\n`,
    );
    await page
      .getByRole('button', { name: '개인 초안 저장', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '대상 Wiki 경로', exact: true })
      .fill('results/rfc9111-answer.md');
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
    mark('result_draft_explicit_wiki_receipt');
    await page
      .getByRole('link', { name: '반영한 Wiki 열기', exact: true })
      .click();
    await expect(
      page.getByRole('article', { name: '위키 본문', exact: true }),
    ).toContainText('실제 모델 통합 시험 결과입니다.');
    await page.screenshot({ path: test.info().outputPath('real-result.png') });
    await application.close();
    application = null;
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: environment,
    });
    page = await application.firstWindow();
    const restored = await page.evaluate(async () =>
      window.wiki?.connection.getState(),
    );
    expect(restored).toMatchObject({
      ok: true,
      data: {
        status: 'connected',
        selection: { tenant: 'alpha', profile: 'all' },
      },
    });
    await openAppPage(page, '문서 목록');
    await page
      .getByRole('list', { name: '문서 목록', exact: true })
      .getByRole('button', { name: /rfc9111-answer/ })
      .click();
    await expect(
      page.getByRole('article', { name: '위키 본문', exact: true }),
    ).toContainText('실제 모델 통합 시험 결과입니다.');
    mark('separate_electron_restart_authenticated_result_read');
  } catch (error: unknown) {
    const currentPage = application?.windows()[0];
    if (currentPage) {
      await writeFile(
        test.info().outputPath('last-visible-screen.txt'),
        await currentPage.locator('body').innerText(),
      );
      await currentPage.screenshot({
        path: test.info().outputPath('last-visible-screen.png'),
      });
    }
    // 실제 모델을 다시 호출하지 않고 실패 화면을 조사할 때만 명시적으로 유지합니다.
    if (process.env.WIKI_LIVE_HOLD_ON_FAILURE === '1') {
      const cleanup = test.info().outputPath('continue-cleanup');
      process.stdout.write(
        `live failure retained for inspection: ${cleanup}\n`,
      );
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        if (
          await readFile(cleanup).then(
            (): boolean => true,
            (): boolean => false,
          )
        )
          break;
        await delay(1000);
      }
    }
    throw error;
  } finally {
    await writeFile(
      test.info().outputPath('milestones.json'),
      JSON.stringify(
        {
          source_sha256: createHash('sha256').update(source).digest('hex'),
          milestones,
          model: 'installed Codex CLI default; no synthetic model',
          human_review: 'automated explicit UI defer, not human approval',
          operational_server: false,
        },
        null,
        2,
      ),
    );
    await application?.close();
    lines.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }
});
