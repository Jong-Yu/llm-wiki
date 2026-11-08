import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { ConnectionService } from '@main/backend/ConnectionService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { QuestionRunService } from '@main/backend/QuestionRunService';
import { AnalysisService } from '@main/backend/AnalysisService';
import { ProposalExecutionService } from '@main/backend/ProposalExecutionService';
import {
  AccountUsageService,
  projectAccountUsage,
  readAccountProtocol,
} from '@main/backend/AccountUsageService';
import { AiSessionsService } from '@main/backend/AiSessionsService';
import type {
  AnalysisProposalRequest,
  AnalysisProposalResult,
} from '@contracts/analysisProposals.contract';
import type { RecoveryResult } from '@contracts/recovery.contract';

const temp = process.env.WIKI_RUNTIME_TEST_ROOT!;
const python = process.env.WIKI_RUNTIME_PYTHON!;
const revision = 'a'.repeat(64),
  one = '1'.repeat(32),
  two = '2'.repeat(32),
  three = '3'.repeat(32),
  conversation = 'c'.repeat(32);
const scope = {
  userId: 'tester',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: revision,
};
const session = { connectionId: 'fixture', expectedScope: scope };
let current = true;
const listeners: Array<() => void> = [];
const access = {
  user_id: 'tester',
  tenant: 'fixture',
  profile_id: 'default',
  policy_revision: revision,
};
const actor = { ...access, domain: null, viewpoint: null };
const server = createServer((req, res) => {
  const id =
    req.url?.match(/(?:question-runs|analysis-jobs)\/([a-f0-9]{32})/)?.[1] ||
    one;
  const question = {
    record: {
      id,
      kind: 'question-runs',
      tenant: 'fixture',
      user_id: 'tester',
      actor,
      data: {
        conversation_id: conversation,
        question_turn_id: id,
        question: 'fixture',
        basis: { snapshot_revision: revision, documents: [] },
      },
    },
    state_revision: revision,
    runtime: { status: 'queued', progress: '' },
    lease_status: 'none',
    answer_requests: [],
    human_approval: false,
    server_ai_executed: false,
  };
  const job = {
    actor,
    job_id: id,
    tenant: 'fixture',
    user_id: 'tester',
    request_id: id,
    created_at: new Date().toISOString(),
    source_ref: {
      source_id: one,
      source_version: one,
      source_sha256: revision,
      size_bytes: 10,
      registration_revision: revision,
    },
    targets: [
      {
        document: `${id}.md`,
        source_revision: revision,
        state_revision: revision,
      },
    ],
    outputs: ['ontology'],
    state: 'awaiting_cli',
    run_id: null,
    reported_status: null,
    job_revision: revision,
    lease_status: 'none',
    lease_expires_at: null,
    basis_status: 'current',
    blockers: [],
    input_readiness: 'ready',
    result_summary: {
      status: 'not_started',
      saved_count: 0,
      required_count: 1,
      results: [],
    },
  };
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      data: {
        access,
        ...(req.url?.includes('analysis-jobs') ? job : question),
      },
      meta: { trace_id: one },
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw Error('server address');
const context: AnalysisContext = {
  active: {
    status: 'connected',
    connectionId: 'fixture',
    serverUrl: `http://127.0.0.1:${address.port}/api/v1/`,
    userId: 'tester',
    policyRevision: revision,
    workspaces: [],
    selection: { tenant: 'fixture', profile: 'default' },
    checkedAt: new Date().toISOString(),
  },
  token: 'isolated-token',
  generation: 1,
  selection: { tenant: 'fixture', profile: 'default' },
};
const connection = new ConnectionService();
connection.analysisContext = async () => context;
connection.isAnalysisCurrent = () => current;
connection.onScopeChanged = (listener: () => void): void => {
  listeners.push(listener);
};
connection.analysisAccessFailure = (): void => {};
const project = join(temp, 'runtime');
await mkdir(join(project, 'tools'), { recursive: true, mode: 0o700 });
const script =
  'import sys\nfor line in sys.stdin:\n if "cancel" in line: break\n';
for (const name of ['question_cli', 'analysis_cli', 'proposal_cli'])
  await writeFile(join(project, 'tools', `${name}.py`), script);
process.env.WIKI_CLIENT_ROOT = project;
process.env.WIKI_CLIENT_PYTHON = python;
process.env.WIKI_AI_PROVIDER = 'codex';
const runtime = {
  projectRoot: project,
  python,
  ai: { provider: 'codex' as const, cli: 'fixture-cli', model: 'default' },
  privateRoot: join(temp, 'questions'),
};
const questions = new QuestionRunService(connection, async () => runtime);
const analysis = new AnalysisService(
  connection,
  undefined,
  join(temp, 'analysis'),
);
const proposalApi = {
  execute: async (
    request: AnalysisProposalRequest,
  ): Promise<AnalysisProposalResult> => {
    const input = request.input;
    return {
      ok: true,
      data: {
        proposal_id: input.proposal_id ?? one,
        execution_id: input.execution_id ?? input.request_id ?? one,
        canonical_changed: false,
        state: 'ready',
        job_id: one,
        job_revision: revision,
      },
    };
  },
};
const recovery = {
  capture: async (): Promise<RecoveryResult> => ({
    ok: true,
    data: { entries: [], complete: true, skipped: [], volatile: false },
  }),
};
const proposals = new ProposalExecutionService(
  connection,
  proposalApi,
  async () => ({ ...runtime, privateRoot: join(temp, 'proposals') }),
  recovery,
);
try {
  const [q1, q2] = await Promise.all(
    [one, two].map((questionRunId) =>
      questions.start({
        ...session,
        questionRunId,
        expectedStateRevision: revision,
        reclaim: false,
      }),
    ),
  );
  assert.equal(q1.ok, true, JSON.stringify(q1));
  assert.equal(q2.ok, true, JSON.stringify(q2));
  assert.equal(questions.activities().length, 2);
  assert.equal(questions.activities()[0].conversationId, conversation);
  const duplicate = await questions.start({
    ...session,
    questionRunId: one,
    expectedStateRevision: revision,
    reclaim: false,
  });
  assert.equal(duplicate.ok, false);
  await questions.cancel({
    ...session,
    questionRunId: one,
    expectedStateRevision: revision,
    requestId: three,
  });
  assert.deepEqual(
    questions.activities().map((item) => item.id),
    [two],
  );
  const [a1, a2] = await Promise.all(
    [one, two].map((jobId) =>
      analysis.execute({
        connectionId: 'fixture',
        jobId,
        expectedJobRevision: revision,
        mode: 'start',
      }),
    ),
  );
  assert.equal(a1.ok, true, JSON.stringify(a1));
  assert.equal(a2.ok, true, JSON.stringify(a2));
  assert.equal(analysis.activities().length, 2);
  const aduplicate = await analysis.execute({
    connectionId: 'fixture',
    jobId: one,
    expectedJobRevision: revision,
    mode: 'start',
  });
  assert.equal(aduplicate.ok, false);
  await analysis.stopLocal({ connectionId: 'fixture', jobId: one });
  assert.deepEqual(
    analysis.activities().map((item) => item.id),
    [two],
  );
  const [p1, p2] = await Promise.all(
    [one, two].map((requestId) =>
      proposals.start({
        ...session,
        proposalId: requestId,
        requestId,
        expectedStateRevision: revision,
        candidateRevision: null,
        semanticCheck: false,
      }),
    ),
  );
  assert.equal(p1.ok, true, JSON.stringify(p1));
  assert.equal(p2.ok, true, JSON.stringify(p2));
  assert.equal(proposals.activities().length, 2);
  await proposals.cancel({ ...session, proposalId: one, executionId: one });
  assert.deepEqual(
    proposals.activities().map((item) => item.id),
    [two],
  );
  current = false;
  listeners.forEach((listener) => listener());
  assert.equal(questions.activities().length, 0);
  assert.equal(analysis.activities().length, 0);
  assert.equal(proposals.activities().length, 0);
  await Promise.all([questions.stop(), analysis.stop(), proposals.shutdown()]);
  assert.equal(
    questions.activeCount + analysis.activeCount + proposals.activeCount,
    0,
  );
  for (const folder of ['questions', 'analysis', 'proposals'])
    for (const execution of await readdir(join(temp, folder))) {
      await assert.rejects(stat(join(temp, folder, execution, 'auth')));
      await stat(join(temp, folder, execution, 'work'));
    }
  current = true;
  // 시작 중 종료 요청이 들어오면 늦은 인증 확인 뒤에도 프로세스를 시작하지 않습니다.
  for (const [start, stop, count] of [
    [
      (): Promise<unknown> =>
        questions.start({
          ...session,
          questionRunId: three,
          expectedStateRevision: revision,
          reclaim: false,
        }),
      (): Promise<void> => questions.stop(),
      (): number => questions.activeCount,
    ],
    [
      (): Promise<unknown> =>
        analysis.execute({
          connectionId: 'fixture',
          jobId: three,
          expectedJobRevision: revision,
          mode: 'start',
        }),
      (): Promise<void> => analysis.stop(),
      (): number => analysis.activeCount,
    ],
    [
      (): Promise<unknown> =>
        proposals.start({
          ...session,
          proposalId: three,
          requestId: three,
          expectedStateRevision: revision,
          candidateRevision: null,
          semanticCheck: false,
        }),
      (): Promise<void> => proposals.shutdown(),
      (): number => proposals.activeCount,
    ],
  ] as const) {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    connection.analysisContext = async () => {
      if (first) {
        first = false;
        entered?.();
        await gate;
      }
      return context;
    };
    const pending = start();
    await ready;
    const stopping = stop();
    release?.();
    await pending;
    await stopping;
    assert.equal(count(), 0);
  }
  connection.analysisContext = async () => context;
  const projected = projectAccountUsage(
    { account: { type: 'chatgpt', email: 'fixture@example.invalid' } },
    {
      rateLimits: { primary: { usedPercent: 0 } },
      rateLimitsByLimitId: {
        codex: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 1800000000,
          },
          secondary: null,
        },
      },
    },
    '2026-10-29T00:00:00Z',
  );
  assert.equal(projected.windows.length, 1);
  assert.equal(projected.windows[0].remainingPercent, 75);
  assert.equal(
    projectAccountUsage({ account: null }, { rateLimits: null }, 'now').status,
    'unavailable',
  );
  assert.throws(() =>
    projectAccountUsage(
      { account: null },
      { rateLimits: { primary: { usedPercent: null } } },
      'now',
    ),
  );
  let calls = 0;
  let provider: 'codex' | 'claude' = 'codex';
  const usage = new AccountUsageService(
    async () => ({ provider, cli: python }),
    async () => {
      calls++;
      return projected;
    },
  );
  await Promise.all([usage.read(), usage.read()]);
  await usage.read();
  assert.equal(calls, 1);
  usage.clear();
  await usage.read();
  assert.equal(calls, 2);
  let releaseUsage: (() => void) | undefined;
  let enteredUsage: (() => void) | undefined;
  const gateUsage = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  const readyUsage = new Promise<void>((resolve) => {
    enteredUsage = resolve;
  });
  const switching = new AccountUsageService(
    async () => ({ provider, cli: python }),
    async () => {
      enteredUsage?.();
      await gateUsage;
      return projected;
    },
  );
  const oldUsage = switching.read();
  await readyUsage;
  provider = 'claude';
  releaseUsage?.();
  const switched = await oldUsage;
  assert.equal(switched.windows.length, 0);
  assert.equal(switched.accountLabel, null);
  provider = 'claude';
  const missing = await usage.read();
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.windows.length, 0);
  const aggregate = new AiSessionsService(
    connection,
    [questions, analysis, proposals],
    usage,
  );
  assert.equal((await aggregate.read({ connectionId: 'fixture' })).ok, true);
  current = false;
  assert.equal((await aggregate.read({ connectionId: 'fixture' })).ok, false);
  current = true;
  const rpcScript = join(temp, 'rpc.mjs');
  await writeFile(
    rpcScript,
    `import readline from 'node:readline';const r=readline.createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{account:{type:'chatgpt',email:'fixture@example.invalid'}}}));if(m.id===3)console.log(JSON.stringify({id:3,result:{rateLimits:{primary:{usedPercent:40}}}}));});`,
  );
  const rpc = await readAccountProtocol(
    spawn(process.execPath, [rpcScript], { stdio: ['pipe', 'pipe', 'pipe'] }),
  );
  assert.equal(rpc.windows[0].remainingPercent, 60);
  console.log(
    'session-runtime: concurrent question/analysis/proposal, duplicate, isolated cancel, scope stop/privacy, token cleanup, account projection/cache/provider/RPC passed',
  );
} finally {
  await Promise.all([questions.stop(), analysis.stop(), proposals.shutdown()]);
  server.close();
}
