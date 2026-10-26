import assert from 'node:assert/strict';
import { spawn as actualSpawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import ts from 'typescript';

const appRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = join(appRoot, 'src');
const bridgeState = { directory: '', spawns: [], handlers: new Map() };
globalThis.__analysisExecutionTest = bridgeState;
const electronStub =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const app = {getPath: () => globalThis.__analysisExecutionTest.directory}; export const ipcMain = {handle: (channel, callback) => globalThis.__analysisExecutionTest.handlers.set(channel, callback)};',
  );
const processStub =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const spawn = (...args) => globalThis.__analysisExecutionTest.spawn(...args);',
  );
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron')
      return { url: electronStub, shortCircuit: true };
    if (
      specifier === 'node:child_process' &&
      context.parentURL?.endsWith('/personalProcess.ts')
    )
      return { url: processStub, shortCircuit: true };
    if (specifier.startsWith('@contracts/'))
      return {
        url: pathToFileURL(
          join(sourceRoot, 'shared/contracts', specifier.slice(11) + '.ts'),
        ).href,
        shortCircuit: true,
      };
    if (specifier.startsWith('@main/'))
      return {
        url: pathToFileURL(join(sourceRoot, 'main', specifier.slice(6) + '.ts'))
          .href,
        shortCircuit: true,
      };
    if (
      specifier.startsWith('.') &&
      context.parentURL?.startsWith('file:') &&
      context.parentURL.includes('/app/src/')
    ) {
      const file = resolve(
        dirname(fileURLToPath(context.parentURL)),
        specifier + '.ts',
      );
      if (existsSync(file))
        return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (
      url.startsWith('file:') &&
      url.endsWith('.ts') &&
      url.includes('/app/src/')
    )
      return {
        format: 'module',
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { AnalysisService } =
  await import('../../src/main/backend/AnalysisService.ts');
const { RecoveryService } =
  await import('../../src/main/backend/RecoveryService.ts');
const { ProtectedRecoveryStore } =
  await import('../../src/main/backend/ProtectedRecoveryStore.ts');
const {
  analysisExecuteRequestSchema,
  analysisReceiptSchema,
  analysisDiagnosticReportSchema,
} = await import('../../src/shared/contracts/analysis.contract.ts');
const savedFetch = globalThis.fetch;
const savedRoot = process.env.WIKI_ANALYSIS_PROJECT_ROOT;
const savedPython = process.env.WIKI_ANALYSIS_PYTHON;
const savedProvider = process.env.WIKI_AI_PROVIDER;
process.env.WIKI_AI_PROVIDER = 'codex';
after(() => {
  hooks.deregister();
  globalThis.fetch = savedFetch;
  delete globalThis.__analysisExecutionTest;
  if (savedRoot === undefined) delete process.env.WIKI_ANALYSIS_PROJECT_ROOT;
  else process.env.WIKI_ANALYSIS_PROJECT_ROOT = savedRoot;
  if (savedPython === undefined) delete process.env.WIKI_ANALYSIS_PYTHON;
  else process.env.WIKI_ANALYSIS_PYTHON = savedPython;
  if (savedProvider === undefined) delete process.env.WIKI_AI_PROVIDER;
  else process.env.WIKI_AI_PROVIDER = savedProvider;
});
const id = 'a'.repeat(32),
  rid = 'b'.repeat(32),
  hash = 'a'.repeat(64);
const actor = {
  user_id: 'tester',
  tenant: 'test',
  profile_id: 'default',
  domain: null,
  viewpoint: null,
  policy_revision: hash,
};
function makeJob() {
  return {
    actor,
    job_id: id,
    tenant: 'test',
    user_id: 'tester',
    request_id: rid,
    created_at: '2026-10-25T00:00:00Z',
    source_ref: {
      source_id: 'c'.repeat(32),
      source_version: 'd'.repeat(32),
      source_sha256: hash,
      size_bytes: 40,
      registration_revision: hash,
    },
    targets: [
      { document: 'result.md', source_revision: null, state_revision: null },
    ],
    outputs: ['wiki', 'ontology'],
    state: 'awaiting_cli',
    run_id: null,
    reported_status: null,
    job_revision: hash,
    lease_status: 'none',
    lease_expires_at: null,
    basis_status: 'current',
    blockers: ['fixed_input_bundle_required', 'personal_ai_execution_required'],
    input_readiness: 'not_prepared',
    result_summary: {
      status: 'not_started',
      saved_count: 0,
      required_count: 2,
      results: [],
    },
    events: [],
  };
}

// 저장/원자 교체/CAS는 실제 모듈이며 이 cipher는 native 보호 검증을 대체하지 않는 시험용입니다.
function recoveryFor(f) {
  f.context.active.workspaces = [
    {
      id: 'test',
      profiles: [{ id: 'default', domain: null, viewpoint: null }],
    },
  ];
  return new RecoveryService(
    f.connection,
    new ProtectedRecoveryStore(join(f.root, 'recovery'), {
      availability: async () => ({
        availability: 'protected',
        backend: 'test',
      }),
      encrypt: async (text) => Buffer.from(text).map((byte) => byte ^ 91),
      decrypt: async (bytes) =>
        Buffer.from(bytes)
          .map((byte) => byte ^ 91)
          .toString('utf8'),
    }),
  );
}

void test('pending analysis creation survives service restart and only GETs exact receipt without replay', async (t) => {
  const f = await fixture(t);
  const recovery = recoveryFor(f);
  const service = new AnalysisService(f.connection, recovery);
  const fallback = globalThis.fetch;
  let creationId;
  let posts = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      creationId = JSON.parse(options.body).request_id;
      throw new Error('response lost');
    }
    if (url.includes('/requests/'))
      return new Response(
        JSON.stringify({
          data: {
            request_id: creationId,
            state: 'complete',
            job_id: id,
            access: {
              user_id: 'tester',
              tenant: 'test',
              policy_revision: hash,
            },
          },
          meta: { trace_id: id },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    return fallback(url, options);
  };
  const request = {
    connectionId: 'connection',
    sourceId: 'c'.repeat(32),
    sourceVersion: 'd'.repeat(32),
    sourceSha256: hash,
    registrationRevision: hash,
    targetDocument: 'result.md',
    outputs: ['wiki'],
  };
  assert.equal((await service.start(request)).ok, false);
  const stored = await recovery.readContext(f.context, 'pending-analysis');
  assert.equal(stored.data.entries.length, 1);
  assert.equal(stored.data.entries[0].payload.includes(f.context.token), false);
  const restarted = new AnalysisService(f.connection, recoveryFor(f));
  const result = await restarted.start(request);
  assert.equal(result.ok, true);
  assert.equal(result.data.job.job_id, id);
  assert.equal(posts, 1);
  assert.equal(bridgeState.spawns.length, 0);
  assert.equal(
    (await recovery.readContext(f.context, 'pending-analysis')).data.entries
      .length,
    0,
  );
});

void test('failed write-ahead recovery prevents POST and shutdown during preparation prevents spawn', async (t) => {
  const f = await fixture(t);
  const recovery = recoveryFor(f);
  recovery.capture = async () => ({
    ok: false,
    error: { code: 'disk_failed', message: 'fixture' },
  });
  const service = new AnalysisService(f.connection, recovery);
  const result = await service.start({
    connectionId: 'connection',
    sourceId: 'c'.repeat(32),
    sourceVersion: 'd'.repeat(32),
    sourceSha256: hash,
    registrationRevision: hash,
    targetDocument: 'result.md',
    outputs: ['wiki'],
  });
  assert.equal(result.ok, false);
  assert.equal(
    f.state.calls.filter((call) => call.method === 'POST').length,
    0,
  );
  let stopped = Promise.resolve();
  f.state.duringRead = () => {
    f.state.duringRead = null;
    stopped = f.service.stop();
  };
  assert.equal((await f.service.execute(f.request)).ok, false);
  await stopped;
  assert.equal(bridgeState.spawns.length, 0);
});
function savedReceipt() {
  return {
    request_id: rid,
    state: 'complete',
    saved: true,
    receipt: {
      actor,
      document: 'result.md',
      stage: 'prepare_wiki',
      source_revision: hash,
      graph_revision: null,
      state_revision: null,
      bundle_id: id,
      bundle_revision: hash,
      review_status: 'unreviewed',
      analysis_basis_revision: hash,
      ruleset_ref: {
        ruleset_id: 'fixture',
        ruleset_version: '1',
        ruleset_revision: hash,
      },
    },
    validation_report: null,
    current_output: { status: 'current' },
    cleanup_failures: [],
  };
}
async function fixture(t) {
  const root = await mkdtemp('/private/tmp/ui_4-analysis-test-');
  await mkdir(join(root, 'tools'));
  await mkdir(join(root, '.venv/bin'), { recursive: true });
  await writeFile(join(root, 'tools/analysis_cli.py'), '# isolated fixture');
  await writeFile(join(root, '.venv/bin/python'), 'not executed');
  bridgeState.directory = root;
  bridgeState.spawns = [];
  process.env.WIKI_ANALYSIS_PROJECT_ROOT = root;
  delete process.env.WIKI_ANALYSIS_PYTHON;
  const state = {
    job: makeJob(),
    receipt: savedReceipt(),
    receiptStatus: 200,
    current: true,
    calls: [],
    accessFailure: false,
    deny: false,
    duringRead: null,
  };
  const context = {
    active: {
      connectionId: 'connection',
      userId: 'tester',
      serverUrl: 'http://fixture.invalid/api/v1/',
      policyRevision: hash,
    },
    selection: { tenant: 'test', profile: 'default' },
    token: 'fixture-secret-not-renderer',
    generation: 1,
  };
  const connection = {
    onScopeChanged() {},
    async analysisContext() {
      return state.deny
        ? {
            ok: false,
            error: { code: 'forbidden', message: 'denied', status: 403 },
          }
        : context;
    },
    isAnalysisCurrent() {
      return state.current;
    },
    analysisAccessFailure() {
      state.accessFailure = true;
    },
  };
  globalThis.fetch = async (url, options) => {
    state.calls.push({ url, method: options.method });
    let data;
    let status = 200;
    if (url.includes('/results/')) {
      data = state.receipt;
      status = state.receiptStatus;
    } else if (url.includes('?'))
      data = {
        items: [state.job],
        next_cursor: null,
        complete: true,
        truncated: false,
        skipped: [],
        requires_refresh: false,
      };
    else data = state.job;
    const value =
      status === 200
        ? {
            data: {
              ...data,
              access: {
                user_id: 'tester',
                tenant: 'test',
                policy_revision: hash,
              },
            },
            meta: { trace_id: id },
          }
        : { error: { code: 'unavailable' } };
    state.duringRead?.();
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  bridgeState.spawn = (python, args, options) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (data) => {
      child.cancelMessage = JSON.parse(data.toString());
      queueMicrotask(() => child.emit('close', 130));
    });
    child.kill = (signal) => {
      child.signal = signal;
      queueMicrotask(() => child.emit('close', 130));
      return true;
    };
    bridgeState.spawns.push({ python, args, options, child });
    return child;
  };
  const service = new AnalysisService(connection);
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true });
  });
  return {
    root,
    connection,
    state,
    context,
    service,
    request: {
      connectionId: 'connection',
      jobId: id,
      expectedJobRevision: hash,
      mode: 'start',
    },
  };
}

void test('list, history and execution inspection only GET; no CLI launch or job creation', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.service.list({
        connectionId: 'connection',
        sourceId: null,
        cursor: null,
      })
    ).ok,
    true,
  );
  assert.equal((await f.service.read(f.request)).ok, true);
  const inspect = await f.service.inspectExecution(f.request);
  assert.equal(inspect.ok, true);
  assert.equal(inspect.data.mode, 'start');
  assert.equal(bridgeState.spawns.length, 0);
  assert.ok(f.state.calls.every((c) => c.method === 'GET'));
});
void test('existing job executes exact ID and CAS once without POST; secret remains in private file', async (t) => {
  const f = await fixture(t);
  const result = await f.service.execute(f.request);
  assert.equal(result.ok, true);
  assert.equal(result.data.local.status, 'running');
  assert.equal(bridgeState.spawns.length, 1);
  const launch = bridgeState.spawns[0];
  assert.equal(launch.args[launch.args.indexOf('--job-id') + 1], id);
  assert.equal(
    launch.args[launch.args.indexOf('--expected-job-revision') + 1],
    hash,
  );
  assert.ok(launch.args.includes('--run-ai'));
  assert.equal(launch.args[launch.args.indexOf('--ai-provider') + 1], 'codex');
  assert.ok(!launch.args.includes('--reclaim'));
  assert.equal(launch.options.shell, false);
  assert.equal(launch.args.includes(f.context.token), false);
  assert.equal(JSON.stringify(result).includes(f.context.token), false);
  const tokenFile = launch.args[launch.args.indexOf('--token-file') + 1];
  assert.equal(await readFile(tokenFile, 'utf8'), f.context.token);
  assert.equal(
    (await f.service.execute(f.request)).error.code,
    'analysis_busy',
  );
  const stopped = await f.service.stopLocal(f.request);
  assert.equal(stopped.data.local.status, 'stopped');
  assert.equal(stopped.data.job.state, 'awaiting_cli');
  assert.deepEqual(launch.child.cancelMessage, { type: 'cancel' });
  assert.equal(
    existsSync(
      join(
        f.root,
        'analysis',
        (await readdir(join(f.root, 'analysis')))[0],
        'auth',
      ),
    ),
    false,
  );
  assert.equal(
    existsSync(
      join(
        f.root,
        'analysis',
        (await readdir(join(f.root, 'analysis')))[0],
        'work',
      ),
    ),
    true,
  );
  assert.ok(f.state.calls.every((c) => c.method === 'GET'));
});
void test('Claude selection launches the exact provider and executable without Codex fallback', async (t) => {
  const before = {
    provider: process.env.WIKI_AI_PROVIDER,
    cli: process.env.WIKI_CLAUDE_CLI,
  };
  t.after(() => {
    if (before.provider === undefined) delete process.env.WIKI_AI_PROVIDER;
    else process.env.WIKI_AI_PROVIDER = before.provider;
    if (before.cli === undefined) delete process.env.WIKI_CLAUDE_CLI;
    else process.env.WIKI_CLAUDE_CLI = before.cli;
  });
  process.env.WIKI_AI_PROVIDER = 'claude';
  process.env.WIKI_CLAUDE_CLI = '/fixture path/claude';
  const f = await fixture(t);
  const result = await f.service.execute(f.request);
  assert.equal(result.ok, true);
  assert.equal(bridgeState.spawns.length, 1);
  const launch = bridgeState.spawns[0];
  assert.equal(launch.args[launch.args.indexOf('--ai-provider') + 1], 'claude');
  assert.equal(
    launch.args[launch.args.indexOf('--ai-cli') + 1],
    '/fixture path/claude',
  );
  await f.service.stopLocal(f.request);
});
void test('partial stopped job preserves receipt and explicitly reclaims same job', async (t) => {
  const f = await fixture(t);
  Object.assign(f.state.job, {
    state: 'claimed',
    run_id: id,
    reported_status: 'stopped',
    lease_status: 'active',
  });
  f.state.job.result_summary = {
    status: 'partial',
    saved_count: 1,
    required_count: 2,
    results: [
      {
        request_id: rid,
        stage: 'prepare_wiki',
        document: 'result.md',
        run_id: id,
        state: 'complete',
        saved: true,
        basis_current: true,
        current_scope: true,
      },
    ],
  };
  const inspected = await f.service.inspectExecution(f.request);
  assert.equal(inspected.data.mode, 'resume');
  const result = await f.service.execute({ ...f.request, mode: 'resume' });
  assert.equal(result.ok, true);
  assert.equal(result.data.receipts[0].saved, true);
  assert.equal(result.data.receipts[0].receipt.analysis_basis_revision, hash);
  assert.equal(
    result.data.receipts[0].receipt.ruleset_ref.ruleset_revision,
    hash,
  );
  assert.ok(bridgeState.spawns[0].args.includes('--reclaim'));
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 0);
});
void test('stale viewed revision and changed mode never launch or retry', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.service.execute({
        ...f.request,
        expectedJobRevision: 'b'.repeat(64),
      })
    ).error.code,
    'conflict',
  );
  assert.equal(
    (await f.service.execute({ ...f.request, mode: 'resume' })).error.code,
    'conflict',
  );
  assert.equal(bridgeState.spawns.length, 0);
});
void test('active lease, cancelled job, source change and profile change each block', async (t) => {
  const f = await fixture(t);
  const variations = [
    { state: 'claimed', lease_status: 'active', run_id: id },
    { state: 'cancelled' },
    { basis_status: 'changed' },
    { actor: { ...actor, profile_id: 'other' } },
    { legacy_rebase_required: true },
  ];
  for (const variation of variations) {
    f.state.job = { ...makeJob(), ...variation };
    const inspected = await f.service.inspectExecution(f.request);
    assert.equal(inspected.data.mode, null);
    assert.ok(inspected.data.blockers.length);
    const result = await f.service.execute({
      ...f.request,
      mode: f.state.job.state === 'awaiting_cli' ? 'start' : 'resume',
    });
    assert.equal(result.ok, false);
  }
  assert.equal(bridgeState.spawns.length, 0);
});
void test('unknown, missing, unreadable or changed saved receipt never permits retry', async (t) => {
  const f = await fixture(t);
  f.state.job.result_summary = {
    status: 'partial',
    saved_count: 1,
    required_count: 2,
    results: [
      {
        request_id: rid,
        stage: 'prepare_wiki',
        document: 'result.md',
        run_id: id,
        state: 'complete',
        saved: true,
      },
    ],
  };
  for (const receipt of [
    { ...savedReceipt(), saved: null, state: 'pending_reconcile' },
    { ...savedReceipt(), current_output: { status: 'changed' } },
    { ...savedReceipt(), current_output: null },
  ]) {
    f.state.receipt = receipt;
    assert.equal((await f.service.inspectExecution(f.request)).data.mode, null);
  }
  f.state.receiptStatus = 503;
  const unread = await f.service.inspectExecution(f.request);
  assert.equal(unread.data.mode, null);
  assert.equal(unread.data.detail.receiptErrors.length, 1);
  assert.equal(bridgeState.spawns.length, 0);
});
void test('Python absent keeps history readable; withdrawn access and late old scope never launch', async (t) => {
  const f = await fixture(t);
  process.env.WIKI_ANALYSIS_PYTHON = join(f.root, 'missing-python');
  assert.equal((await f.service.read(f.request)).ok, true);
  assert.equal((await f.service.inspectExecution(f.request)).data.mode, null);
  assert.equal(
    (await f.service.execute(f.request)).error.code,
    'python_unavailable',
  );
  f.state.deny = true;
  assert.equal((await f.service.execute(f.request)).error.code, 'forbidden');
  f.state.deny = false;
  f.state.duringRead = () => {
    f.state.current = false;
  };
  assert.equal(
    (await f.service.execute(f.request)).error.code,
    'connection_changed',
  );
  assert.equal(bridgeState.spawns.length, 0);
});
void test('strict execution contract rejects arbitrary shell arguments and missing CAS', () => {
  const input = {
    connectionId: 'connection',
    jobId: id,
    expectedJobRevision: hash,
    mode: 'resume',
  };
  assert.equal(analysisExecuteRequestSchema.safeParse(input).success, true);
  assert.equal(
    analysisExecuteRequestSchema.safeParse({ ...input, command: 'malicious' })
      .success,
    false,
  );
  const { expectedJobRevision: _revision, ...withoutRevision } = input;
  assert.equal(
    analysisExecuteRequestSchema.safeParse(withoutRevision).success,
    false,
  );
});

void test(
  'real isolated Python process receives fixed arguments and stops with token cleanup',
  { skip: !existsSync('/usr/bin/python3') },
  async (t) => {
    const f = await fixture(t);
    process.env.WIKI_ANALYSIS_PYTHON = '/usr/bin/python3';
    await writeFile(
      join(f.root, 'tools/analysis_cli.py'),
      `import json,sys,signal,time
from pathlib import Path
signal.signal(signal.SIGINT, lambda *args: sys.exit(130))
Path('received.json').write_text(json.dumps(sys.argv[1:]))
for line in sys.stdin:
    if json.loads(line).get('type') == 'cancel': sys.exit(130)
`,
    );
    bridgeState.spawn = (python, args, options) => {
      const child = actualSpawn(python, args, options);
      bridgeState.spawns.push({ python, args, options, child });
      return child;
    };
    assert.equal((await f.service.execute(f.request)).ok, true);
    for (
      let count = 0;
      count < 100 && !existsSync(join(f.root, 'received.json'));
      count++
    )
      await delay(25);
    const received = JSON.parse(
      await readFile(join(f.root, 'received.json'), 'utf8'),
    );
    assert.equal(received[received.indexOf('--job-id') + 1], id);
    assert.equal(
      received[received.indexOf('--expected-job-revision') + 1],
      hash,
    );
    const result = await f.service.stopLocal(f.request);
    assert.equal(result.data.local.status, 'stopped');
    assert.equal(bridgeState.spawns[0].child.exitCode, 130);
    assert.equal(
      existsSync(
        join(
          f.root,
          'analysis',
          (await readdir(join(f.root, 'analysis')))[0],
          'auth',
        ),
      ),
      false,
    );
    assert.equal(
      existsSync(
        join(
          f.root,
          'analysis',
          (await readdir(join(f.root, 'analysis')))[0],
          'work',
        ),
      ),
      true,
    );
  },
);
void test('diagnostic v1/v2 and five rule states remain distinct through the receipt contract', () => {
  const common = {
    reviewer_kind: 'separate_ai',
    warnings: [],
    omissions: [],
    unread_ranges: [],
    reviewed_ranges: [],
    findings: [],
  };
  const ruleResults = Array.from({ length: 10 }, (_, index) => ({
    rule_id: 'R-S' + String(index + 1).padStart(2, '0'),
    status: ['pass', 'fail', 'not_run', 'not_applicable', 'error'][index % 5],
    reason: 'fixture',
    finding_indices: [],
  }));
  const report = {
    ...common,
    schema_version: 2,
    rule_results: ruleResults,
    semantic_check: null,
  };
  for (const provider of ['codex', 'claude']) {
    const execution = {
      provider,
      cli_version: 'fixture',
      prompt_sha256: hash,
      schema_sha256: hash,
      output_sha256: hash,
    };
    const value = analysisDiagnosticReportSchema.parse({
      ...report,
      semantic_check: {
        check_id: id,
        input: {
          job_id: id,
          run_id: id,
          bundle_id: id,
          bundle_revision: hash,
          document: 'result.md',
          source_revision: hash,
          submission_sha256: hash,
          schema_version: 6,
          ruleset_ref: {
            ruleset_id: 'fixture',
            ruleset_version: 'v1',
            ruleset_revision: hash,
          },
        },
        source_audit_execution: execution,
        assessment_execution: execution,
        source_audit_sha256: hash,
        source_audit: 'fixture',
      },
    });
    assert.equal(
      value.semantic_check.source_audit_execution.provider,
      provider,
    );
    assert.equal(value.semantic_check.assessment_execution.provider, provider);
  }
  assert.equal(
    analysisDiagnosticReportSchema.parse({ ...common, schema_version: 1 })
      .schema_version,
    1,
  );
  const receipt = analysisReceiptSchema.parse({
    ...savedReceipt(),
    diagnostics: {
      report_id: rid,
      report_hash: hash,
      origin: 'client_reported',
      human_approval: false,
      validation: 'structure_and_source_checked',
      basis: {
        job_id: id,
        run_id: id,
        bundle_id: id,
        bundle_revision: hash,
        document: 'result.md',
        stage: 'extract_ontology',
        source_revision: hash,
        submission_hash: hash,
      },
      report,
      semantic: {
        status: 'client_reported',
        human_approval: false,
        reviewer_kind: 'separate_ai',
        rule_results: ruleResults,
      },
    },
  });
  assert.deepEqual(receipt.diagnostics.report.rule_results, ruleResults);
  assert.equal(receipt.diagnostics.semantic.human_approval, false);
  assert.equal(
    analysisReceiptSchema.safeParse({
      ...receipt,
      diagnostics: { ...receipt.diagnostics, human_approval: true },
    }).success,
    false,
  );
});
void test('DOCX and image conversion positions are preserved in plan payloads and validated', async () => {
  const {
    emptyConversion,
    emptyLocation,
    analysisLocation,
    conversionLocationKinds,
    conversionMethods,
    locationFieldsSchema,
    planFieldsSchema,
    emptyPlan,
  } =
    await import('../../src/renderer/features/plan-analysis/model/analysisPlan.schema.ts');
  const { analysisLocationSchema } =
    await import('../../src/shared/contracts/workspace.contract.ts');
  const table = {
    ...emptyLocation(),
    kind: 'table_cells',
    table: '2',
    row: '3',
    column: '4',
  };
  assert.equal(locationFieldsSchema.safeParse(table).success, true);
  assert.deepEqual(analysisLocationSchema.parse(analysisLocation(table)), {
    kind: 'table_cells',
    table: 2,
    row: 3,
    column: 4,
  });
  assert.equal(
    locationFieldsSchema.safeParse({ ...table, row: '0' }).success,
    false,
  );
  const paragraphs = {
    ...emptyLocation(),
    kind: 'paragraphs',
    start: '2',
    end: '9',
  };
  assert.equal(
    analysisLocationSchema.parse(analysisLocation(paragraphs)).end,
    9,
  );
  assert.equal(emptyConversion('docx').method, 'docx_text');
  assert.ok(conversionLocationKinds('docx').includes('blocks'));
  assert.deepEqual(conversionMethods('png'), ['ocr']);
  const plan = emptyPlan();
  plan.locations = [paragraphs, table];
  plan.outputs = [
    {
      document: 'result.md',
      title: '보존 제목',
      purpose: '원본 표와 문단 비교',
      selectedRanges: ['0', '1'],
      outputs: ['wiki', 'ontology'],
    },
  ];
  plan.contexts = [
    { document: 'context.md', required: true, reason: '정의·예외 확인' },
  ];
  const parsed = planFieldsSchema.parse(plan);
  assert.deepEqual(parsed.outputs, plan.outputs);
  assert.deepEqual(parsed.contexts, plan.contexts);
});

void test('dedicated execution IPC rejects other windows, subframes, extra arguments and shell input', async () => {
  const { registerAnalysisExecutionHandlers } =
    await import('../../src/main/ipc/registerAnalysisExecutionHandlers.ts');
  const calls = [];
  const service = {
    inspectExecution: async (request) => {
      calls.push(['inspect', request]);
      return { ok: true, data: {} };
    },
    execute: async (request) => {
      calls.push(['execute', request]);
      return { ok: true, data: {} };
    },
    stopLocal: async (request) => {
      calls.push(['stop', request]);
      return { ok: true, data: {} };
    },
  };
  const mainFrame = { url: 'file:///fixture/index.html#/analysis' };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  registerAnalysisExecutionHandlers(
    () => window,
    'file:///fixture/index.html',
    service,
  );
  const handler = bridgeState.handlers.get('analysis:execute');
  const event = { sender: webContents, senderFrame: mainFrame };
  const request = {
    connectionId: 'connection',
    jobId: id,
    expectedJobRevision: hash,
    mode: 'resume',
  };
  assert.equal(
    (await handler({ ...event, sender: {} }, request)).error.code,
    'forbidden',
  );
  assert.equal(
    (await handler({ ...event, senderFrame: { ...mainFrame } }, request)).error
      .code,
    'forbidden',
  );
  assert.equal(
    (await handler(event, request, 'extra')).error.code,
    'invalid_request',
  );
  assert.equal(
    (await handler(event, { ...request, command: 'arbitrary' })).error.code,
    'invalid_request',
  );
  assert.equal(calls.length, 0);
  assert.equal((await handler(event, request)).ok, true);
  assert.deepEqual(calls, [['execute', request]]);
});
