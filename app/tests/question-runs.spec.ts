import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  realpath,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { processRecoveryFixture } from './helpers/processRecoveryFixture';
import { QuestionRunService } from '../src/main/backend/QuestionRunService';
import type { AnalysisContext } from '../src/main/backend/ConnectionService';
import type { QuestionConnection } from '../src/main/backend/QuestionRunService';
import { parseAccessContext } from '../src/shared/contracts/connection.contract';
import {
  applyQuestionCliEvent,
  idleQuestionLocal,
  projectQuestion,
} from '../src/main/backend/questionRunProjection';
import {
  questionCreateSchema,
  parseQuestionDetailResult,
} from '../src/shared/contracts/questionRuns.contract';
import type {
  QuestionSession,
  QuestionDetail,
} from '../src/shared/contracts/questionRuns.contract';
import {
  canStartQuestion,
  questionStorageLabel,
  hasUnconfirmedQuestionAnswer,
} from '../src/renderer/features/run-question/model/questionRun';

const hexId = 'a'.repeat(32);
const hash = 'b'.repeat(64);
const session: QuestionSession = {
  connectionId: 'fixture',
  expectedScope: {
    userId: 'alice',
    tenant: 'alpha',
    profileId: 'all',
    policyRevision: hash,
  },
};
/** 서버 projection 검증을 위해 임의 원문은 main 안에만 넣습니다. */
function storedRun(): unknown {
  return {
    record: {
      id: hexId,
      kind: 'question-runs',
      tenant: 'alpha',
      user_id: 'alice',
      actor: { profile_id: 'all' },
      data: {
        conversation_id: hexId,
        question_turn_id: hexId,
        question: '조건은?',
        basis: {
          snapshot_revision: hash,
          documents: [],
          originals: [
            {
              source_ref: {
                source_id: hexId,
                source_version: hexId,
                source_sha256: hash,
              },
              content: '비공개 전체 원본',
            },
          ],
        },
      },
    },
    state_revision: hash,
    runtime: { status: 'queued', progress: 'prepared' },
    lease_status: 'none',
    answer_requests: [],
    human_approval: false,
    server_ai_executed: false,
  };
}
test('생성문은 미저장 스냅샷이고 stdout 완료를 저장 증거로 승격하지 않음', (): void => {
  const base = idleQuestionLocal();
  const preview = applyQuestionCliEvent(
    base,
    {
      protocol: 'question-cli-v1',
      type: 'answer_preview',
      saved: false,
      origin: 'client_reported',
      content: '생성 중',
    },
    hexId,
  );
  expect(preview.preview).toBe('생성 중');
  expect(
    applyQuestionCliEvent(
      preview,
      {
        protocol: 'question-cli-v1',
        type: 'answer_preview',
        saved: false,
        origin: 'client_reported',
        content: '전체 교체',
      },
      hexId,
    ).preview,
  ).toBe('전체 교체');
  expect(
    applyQuestionCliEvent(
      preview,
      {
        protocol: 'question-cli-v1',
        type: 'result',
        saved: true,
        receipt: { fabricated: true },
      },
      hexId,
    ).status,
  ).toBe('idle');
  expect(
    applyQuestionCliEvent(
      preview,
      {
        protocol: 'question-cli-v1',
        type: 'answer_preview',
        question_run_id: 'c'.repeat(32),
        saved: false,
        origin: 'client_reported',
        content: '다른 질문',
      },
      hexId,
    ),
  ).toEqual(preview);
  expect(
    applyQuestionCliEvent(
      preview,
      {
        protocol: 'question-cli-v1',
        type: 'answer_preview',
        saved: true,
        origin: 'client_reported',
        content: '가짜 저장',
      },
      hexId,
    ),
  ).toEqual(preview);
});
test('source-only 판본 보존, 원본 비노출, 관점 불일치와 과잉 IPC 입력 거부', (): void => {
  const detail = projectQuestion(storedRun(), session, hexId);
  expect(detail.evidence).toHaveLength(1);
  expect(detail.evidence[0]?.sourceVersion).toBe(hexId);
  expect(JSON.stringify(detail)).not.toContain('비공개 전체 원본');
  expect((): void => {
    projectQuestion(storedRun(), {
      ...session,
      expectedScope: { ...session.expectedScope, profileId: 'other' },
    });
  }).toThrow();
  expect(
    questionCreateSchema.safeParse({
      ...session,
      requestId: hexId,
      conversationId: hexId,
      questionTurnId: hexId,
      conversationRevision: hash,
      shell: 'unsafe',
    }).success,
  ).toBe(false);
  expect(parseQuestionDetailResult({ ok: true, data: detail })).toEqual({
    ok: true,
    data: detail,
  });
});
test('영수증 미확인/취소/실행 종료를 저장 완료와 구분하고 자동 재실행 차단', (): void => {
  const detail = projectQuestion(storedRun(), session);
  expect(canStartQuestion(detail)).toBe(true);
  detail.local.requestId = hexId;
  expect(canStartQuestion(detail)).toBe(false);
  expect(questionStorageLabel(detail)).toContain('확인 필요');
  expect(hasUnconfirmedQuestionAnswer(detail)).toBe(true);
  detail.local.requestId = null;
  detail.status = 'cancelled';
  expect(questionStorageLabel(detail)).toContain('취소됨');
  expect(canStartQuestion(detail)).toBe(false);
});

const fixtureSchema = z.object({
  serverUrl: z.string(),
  root: z.string(),
  fakeCli: z.string(),
  modePath: z.string(),
  countPath: z.string(),
});
const recordSchema = z.object({
  data: z.object({
    record: z.object({ id: z.string() }),
    revision: z.string(),
  }),
});
/** 실제 API+CLI 왕복을 검사하되 모델 출력만 합성 실행기로 대체합니다. */
for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: main → 실제 question CLI → 실제 임시 API: source-only 저장·preview·취소·실패·CAS·조회 보존`, async (): Promise<void> => {
    const privateRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'wiki-question-main-')),
    );
    const token = randomBytes(32).toString('hex');
    const server = spawn(
      resolve('../.venv/bin/python'),
      ['-B', resolve('tests/fixtures/question_server.py')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = createInterface({ input: server.stdout });
    let stderr = '';
    server.stderr.on('data', (chunk: Buffer): void => {
      stderr += chunk.toString();
    });
    let service: QuestionRunService | undefined;
    try {
      const ready = Promise.race([
        once(lines, 'line').then((values: unknown[]): unknown => {
          if (typeof values[0] !== 'string') throw new Error('fixture');
          return JSON.parse(values[0]);
        }),
        once(server, 'exit').then((): never => {
          throw new Error(stderr);
        }),
      ]);
      server.stdin.end(JSON.stringify({ token }) + '\n');
      const fixture = fixtureSchema.parse(await ready);
      const accessResponse = await fetch(
        fixture.serverUrl + '/api/v1/access-context',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const access = parseAccessContext(await accessResponse.json());
      const context: AnalysisContext = {
        token,
        generation: 1,
        selection: { tenant: 'alpha', profile: 'all' },
        active: {
          status: 'connected',
          connectionId: 'fixture',
          serverUrl: fixture.serverUrl + '/api/v1/',
          userId: access.userId,
          policyRevision: access.policyRevision,
          workspaces: access.workspaces,
          selection: { tenant: 'alpha', profile: 'all' },
          checkedAt: new Date().toISOString(),
        },
      };
      // 연결 선택 수명만 고정 fixture이며 HTTP 인증·권한·CAS·CLI·저장은 실제 제품 경로입니다.
      const connection: QuestionConnection = {
        analysisContext: async (): Promise<AnalysisContext> => context,
        isAnalysisCurrent: (candidate: AnalysisContext): boolean =>
          candidate === context,
        analysisAccessFailure: (): void => {},
        onScopeChanged: (): void => {},
      };
      const scope: QuestionSession = {
        connectionId: 'fixture',
        expectedScope: {
          userId: access.userId,
          tenant: 'alpha',
          profileId: 'all',
          policyRevision: access.policyRevision,
        },
      };
      const recovery = processRecoveryFixture(
        connection,
        join(privateRoot, 'recovery'),
      );
      service = new QuestionRunService(
        connection,
        async (): Promise<{
          projectRoot: string;
          python: string;
          ai: { provider: 'codex' | 'claude'; cli: string };
          privateRoot: string;
        }> => ({
          projectRoot: resolve('..'),
          python: resolve('../.venv/bin/python'),
          ai: { provider, cli: fixture.fakeCli },
          privateRoot,
        }),
        recovery,
      );
      const questions = service;
      const base = fixture.serverUrl + '/api/v1/tenants/alpha';
      /** fixture 사용자로만 질문 입력을 저장합니다. */
      async function post(path: string, body: unknown): Promise<unknown> {
        const response = await fetch(base + path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const value: unknown = await response.json();
        expect(response.ok, JSON.stringify(value)).toBe(true);
        return value;
      }
      const source = z
        .object({
          data: z.object({
            source_id: z.string(),
            source_version: z.string(),
            source_sha256: z.string(),
          }),
        })
        .parse(
          await post('/sources', {
            request_id: randomUUID().replaceAll('-', ''),
            title: 'source-only question fixture',
            format: 'txt',
            content: '원본 조건은 이 문자입니다.',
          }),
        ).data;
      /** 대화마다 독립한 CAS 기준을 만들며 기존 자료는 직접 덮어쓰지 않습니다. */
      async function makeQuestion(
        sourceOnly: boolean,
      ): Promise<QuestionDetail> {
        const made = recordSchema.parse(
          await post('/conversations', {
            request_id: randomUUID().replaceAll('-', ''),
            title: '질문 실행 fixture',
            profile: 'all',
          }),
        ).data;
        const turn = randomUUID().replaceAll('-', '');
        const asked = recordSchema.parse(
          await post(`/conversations/${made.record.id}/turns`, {
            request_id: turn,
            expected_revision: made.revision,
            role: 'user',
            content: '조건을 알려 주세요.',
            profile: 'all',
            context_request: sourceOnly
              ? { documents: [], source_refs: [source] }
              : { documents: ['target.md'], required_documents: ['target.md'] },
          }),
        ).data;
        const requestId = randomUUID().replaceAll('-', '');
        const bad = await questions.create({
          ...scope,
          conversationId: made.record.id,
          questionTurnId: turn,
          conversationRevision: '0'.repeat(64),
          requestId: randomUUID().replaceAll('-', ''),
        });
        expect(bad.ok).toBe(false);
        const created = await questions.create({
          ...scope,
          conversationId: made.record.id,
          questionTurnId: turn,
          conversationRevision: asked.revision,
          requestId,
        });
        if (!created.ok) throw new Error(JSON.stringify(created));
        const receipt = await questions.creationReceipt({
          ...scope,
          requestId,
        });
        expect(receipt.ok).toBe(true);
        return created.data;
      }
      const run = await makeQuestion(true);
      expect(run.evidence[0]?.kind).toBe('source');
      expect(run.evidence[0]?.sourceVersion).toBe(source.source_version);
      expect(await readFile(fixture.countPath, 'utf8')).toBe('0');
      const started = await questions.start({
        ...scope,
        questionRunId: run.id,
        expectedStateRevision: run.stateRevision,
        reclaim: false,
      });
      expect(started.ok).toBe(true);
      let completed: QuestionDetail = run;
      let sawPreview = false;
      await expect
        .poll(
          async (): Promise<boolean> => {
            const result = await questions.read({
              ...scope,
              questionRunId: run.id,
            });
            if (!result.ok) throw new Error(JSON.stringify(result));
            completed = result.data;
            if (result.data.local.status === 'failed')
              throw new Error(
                JSON.stringify({
                  local: result.data.local,
                  progress: result.data.progress,
                  status: result.data.status,
                }),
              );
            sawPreview ||=
              Boolean(result.data.local.preview) &&
              result.data.answers.length === 0;
            return result.data.answers.length === 1;
          },
          { timeout: 20000, intervals: [100, 200] },
        )
        .toBe(true);
      expect(sawPreview).toBe(true);
      expect(completed.receipts[0]?.saved).toBe(true);
      expect(completed.receipts[0]?.receipt?.execution).toMatchObject({
        provider,
      });
      const reopened = new QuestionRunService(
        connection,
        async (): Promise<never> => {
          throw new Error('restart must not execute');
        },
        recovery,
      );
      const restored = await reopened.read({ ...scope, questionRunId: run.id });
      expect(restored.ok && restored.data.receipts[0]?.saved).toBe(true);
      expect(
        restored.ok && restored.data.receipts[0]?.receipt?.execution,
      ).toMatchObject({ provider });
      expect(restored.ok && restored.data.local.preview).toBe('');
      expect(
        (await recovery.readContext(context, 'pending-question-run')).ok,
      ).toBe(true);
      expect(completed.answers[0]?.content).toBe('합성 질문 답변입니다.');
      expect(completed.answers[0]?.citations[0]?.source_version).toBe(
        source.source_version,
      );
      expect(JSON.stringify(completed)).not.toContain(token);
      expect(JSON.stringify(completed)).not.toContain(fixture.root);
      const count = await readFile(fixture.countPath, 'utf8');
      await questions.read({ ...scope, questionRunId: run.id });
      await questions.list({ ...scope, cursor: null });
      expect(await readFile(fixture.countPath, 'utf8')).toBe(count);
      expect(
        (
          await questions.start({
            ...scope,
            questionRunId: run.id,
            expectedStateRevision: completed.stateRevision,
            reclaim: false,
          })
        ).ok,
      ).toBe(false);
      await expect
        .poll(async (): Promise<string[]> =>
          Promise.all(
            (await readdir(privateRoot))
              .filter((name: string): boolean => name.startsWith('exec-'))
              .map(async (name: string): Promise<string[]> =>
                (await readdir(join(privateRoot, name))).filter(
                  (part: string): boolean => part === 'auth',
                ),
              ),
          ).then((parts: string[][]): string[] => parts.flat()),
        )
        .toEqual([]);
      const cancelled = await makeQuestion(false);
      await writeFile(fixture.modePath, 'wait');
      expect(
        (
          await questions.start({
            ...scope,
            questionRunId: cancelled.id,
            expectedStateRevision: cancelled.stateRevision,
            reclaim: false,
          })
        ).ok,
      ).toBe(true);
      await expect
        .poll(
          async (): Promise<boolean> => {
            const result = await questions.read({
              ...scope,
              questionRunId: cancelled.id,
            });
            return result.ok && Boolean(result.data.local.preview);
          },
          { timeout: 15000 },
        )
        .toBe(true);
      const before = await questions.read({
        ...scope,
        questionRunId: cancelled.id,
      });
      if (!before.ok) throw new Error('read');
      const stopped = await questions.cancel({
        ...scope,
        questionRunId: cancelled.id,
        requestId: randomUUID().replaceAll('-', ''),
        expectedStateRevision: before.data.stateRevision,
      });
      expect(stopped.ok).toBe(true);
      if (stopped.ok) {
        expect(stopped.data.status).toBe('cancelled');
        expect(stopped.data.answers).toEqual([]);
      }
      const failed = await makeQuestion(false);
      await writeFile(fixture.modePath, 'fail');
      expect(
        (
          await questions.start({
            ...scope,
            questionRunId: failed.id,
            expectedStateRevision: failed.stateRevision,
            reclaim: false,
          })
        ).ok,
      ).toBe(true);
      await expect
        .poll(
          async (): Promise<string | undefined> => {
            const result = await questions.read({
              ...scope,
              questionRunId: failed.id,
            });
            return result.ok ? result.data.local.status : undefined;
          },
          { timeout: 15000 },
        )
        .toBe('failed');
      const failure = await questions.read({
        ...scope,
        questionRunId: failed.id,
      });
      expect(failure.ok).toBe(true);
      if (failure.ok) expect(failure.data.answers).toEqual([]);
      const mismatch = await questions.read({
        ...scope,
        expectedScope: { ...scope.expectedScope, profileId: 'other' },
        questionRunId: run.id,
      });
      expect(mismatch.ok).toBe(false);
      const preserved = await questions.read({
        ...scope,
        questionRunId: run.id,
      });
      if (!preserved.ok) throw new Error('stored answer lost');
      expect(preserved.data.answers).toHaveLength(1);
    } finally {
      await service?.stop();
      server.kill('SIGTERM');
      if (server.exitCode === null) await once(server, 'exit');
      lines.close();
      await rm(privateRoot, { recursive: true, force: true });
    }
  });
}
