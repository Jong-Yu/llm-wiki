import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
const temporary = await mkdtemp(join(tmpdir(), 'ui8-execution-'));
const vite = await createServer({
  configFile: false,
  root: resolve('.'),
  cacheDir: join(temporary, 'vite'),
  resolve: {
    alias: {
      '@contracts': resolve('src/shared/contracts'),
      '@renderer': resolve('src/renderer'),
      '@main': resolve('src/main'),
    },
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  logLevel: 'error',
});
after(async () => {
  await vite.close();
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 6,
    retryDelay: 100,
  });
});
const { AnalysisProposalsApi } = await vite.ssrLoadModule(
  '/src/main/backend/AnalysisProposalsApi.ts',
);
const { ProposalExecutionService, idleProposalLocal, applyProposalCliEvent } =
  await vite.ssrLoadModule('/src/main/backend/ProposalExecutionService.ts');
const { proposalSchema } = await vite.ssrLoadModule(
  '/src/renderer/features/review-analysis-proposals/model/analysisProposal.schema.ts',
);
const { verifiedProposalReports } = await vite.ssrLoadModule(
  '/src/renderer/features/review-analysis-proposals/model/proposalReports.ts',
);
const { ProposalExecutionSession } = await vite.ssrLoadModule(
  '/src/renderer/features/review-analysis-proposals/model/ProposalExecutionSession.ts',
);
const id = 'a'.repeat(32),
  hash = 'b'.repeat(64);
const scope = {
  connectionId: 'fixture',
  userId: 'alice',
  tenant: 'alpha',
  profileId: 'all',
  policyRevision: hash,
  permissions: ['read', 'source_write', 'ontology_write'],
};
await test('bounded snapshots and foreign CLI events never create saved status', () => {
  const local = idleProposalLocal();
  assert.deepEqual(
    applyProposalCliEvent(
      local,
      {
        protocol: 'proposal-cli-v1',
        type: 'progress',
        execution_id: 'f'.repeat(32),
        phase: 'candidate_saved',
      },
      id,
    ),
    local,
  );
  let next = applyProposalCliEvent(
    local,
    {
      protocol: 'proposal-cli-v1',
      type: 'candidate_preview',
      execution_id: id,
      text: 'a',
    },
    id,
  );
  next = applyProposalCliEvent(
    next,
    {
      protocol: 'proposal-cli-v1',
      type: 'candidate_preview',
      execution_id: id,
      text: 'ab',
      truncated: true,
    },
    id,
  );
  assert.equal(next.preview, 'ab');
  assert.equal(next.previewTruncated, true);
  assert.equal(next.status, 'idle');
  next = applyProposalCliEvent(
    next,
    {
      protocol: 'proposal-cli-v1',
      type: 'result',
      execution_id: id,
      status: 'partial',
      error: { code: 'semantic_failed' },
    },
    id,
  );
  assert.equal(next.phase, 'partial');
  assert.equal(next.errorCode, 'semantic_failed');
});
await test('execution response loss keeps request; recovery only reads; failed journal prevents start', async () => {
  const calls = [];
  const session = new ProposalExecutionSession(scope, {
    start: async (request) => {
      calls.push(['start', request]);
      throw Error('IPC loss');
    },
    read: async (request) => {
      calls.push(['read', request]);
      return {
        ok: false,
        error: { code: 'not_found', message: 'unconfirmed' },
      };
    },
    cancel: async () => {
      throw Error();
    },
  });
  const record = { proposal_id: id, state_revision: hash, candidate_ref: null };
  await session.start(record, false);
  await session.start(record, false);
  await session.read();
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ['start', 'read'],
  );
  assert.equal(calls[1][1].executionId, calls[0][1].requestId);
  const blocked = new ProposalExecutionSession(scope, {
    start: async () => {
      throw Error('must not start');
    },
  });
  blocked.beforeStart = async () => {
    throw Error('storage');
  };
  await blocked.start(record, false);
  assert.equal(blocked.snapshot().request, null);
  assert.match(blocked.snapshot().error, /시작하지 않았습니다/);
});
await test('first execution response must match the persisted request ID', async () => {
  const session = new ProposalExecutionSession(scope, {
    start: async (request) => ({
      ok: true,
      data: {
        proposalId: request.proposalId,
        executionId: 'f'.repeat(32),
        server: { state: 'candidate_ready' },
        local: idleProposalLocal(),
      },
    }),
  });
  await session.start(
    { proposal_id: id, state_revision: hash, candidate_ref: null },
    false,
  );
  assert.equal(session.snapshot().detail, null);
  assert.match(session.snapshot().error, /실행 ID가 달라/);
  assert.equal(session.snapshot().request.proposalId, id);
});

await test(
  'actual proposal CLI and HTTP/MCP: candidate + separate report, exact refs, no canonical apply, cancel',
  { timeout: 90000 },
  async () => {
    const child = spawn(
      resolve('../.venv/bin/python'),
      ['-B', resolve('tests/analysis-proposals/execution_server.py')],
      { cwd: resolve('..'), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let service;
    try {
      const setup = await Promise.race([
        once(lines, 'line').then(([line]) => JSON.parse(line)),
        once(child, 'exit').then(() => {
          throw Error('fixture failed: ' + stderr);
        }),
      ]);
      const token = await readFile(setup.token_file, 'utf8');
      const access = setup.proposal.access;
      const expectedScope = {
        userId: access.user_id,
        tenant: access.tenant,
        profileId: access.profile_id,
        policyRevision: access.policy_revision,
      };
      const context = {
        active: {
          connectionId: 'execution-fixture',
          serverUrl: setup.url + '/api/v1/',
          userId: access.user_id,
          policyRevision: access.policy_revision,
          workspaces: [
            {
              id: 'alpha',
              permissions: ['read', 'source_write', 'ontology_write'],
              profiles: [{ id: 'all', domain: null, viewpoint: null }],
            },
          ],
        },
        selection: { tenant: 'alpha', profile: 'all' },
        token,
      };
      const connection = {
        analysisContext: async () => context,
        isAnalysisCurrent: () => true,
        onScopeChanged: () => {},
        invalidateApiScope: () => {},
      };
      const api = new AnalysisProposalsApi(connection);
      const captured = [];
      service = new ProposalExecutionService(
        connection,
        api,
        async () => ({
          projectRoot: resolve('..'),
          python: resolve('../.venv/bin/python'),
          ai: { provider: 'codex', cli: setup.codex },
          privateRoot: setup.private_root,
        }),
        {
          capture: async (...args) => {
            captured.push(args);
            return { ok: true, data: { entries: [], cleanupWarningCount: 0 } };
          },
        },
      );
      const request = {
        connectionId: 'execution-fixture',
        expectedScope,
        proposalId: setup.proposal.proposal_id,
        requestId: crypto.randomUUID().replaceAll('-', ''),
        expectedStateRevision: setup.proposal.state_revision,
        candidateRevision: null,
        semanticCheck: true,
      };
      let detail = await service.start(request);
      assert.equal(detail.ok, true, JSON.stringify(detail));
      assert.equal(captured.length, 1);
      assert.equal(captured[0][2], 'proposal-' + request.requestId);
      const lookup = {
        connectionId: request.connectionId,
        expectedScope,
        proposalId: request.proposalId,
        executionId: request.requestId,
      };
      for (let attempt = 0; attempt < 150; attempt++) {
        detail = await service.read(lookup);
        assert.equal(detail.ok, true, JSON.stringify(detail));
        if (detail.data.local.status !== 'running') break;
        await new Promise((done) => setTimeout(done, 150));
      }
      assert.equal(detail.data.local.status, 'exited', JSON.stringify(detail));
      assert.equal(detail.data.server.state, 'candidate_ready');
      const response = await api.execute({
        connectionId: request.connectionId,
        expectedScope,
        operation: 'read',
        input: { proposal_id: request.proposalId },
      });
      assert.equal(response.ok, true);
      const record = proposalSchema.parse(response.data);
      assert.equal(record.result_links.length, 2);
      const reports = await verifiedProposalReports(record);
      assert.equal(reports.reports.length, 2, JSON.stringify(reports));
      assert.equal(reports.unavailable.length, 0);
      assert.equal(record.human_approval, false);
      const browserServer = await createServer({
        configFile: false,
        root: resolve('.'),
        cacheDir: join(temporary, 'browser-vite'),
        plugins: [react()],
        resolve: {
          alias: {
            '@contracts': resolve('src/shared/contracts'),
            '@renderer': resolve('src/renderer'),
          },
        },
        server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
        logLevel: 'error',
      });
      let browser;
      try {
        await browserServer.listen();
        browser = await chromium.launch({
          headless: true,
          ...(process.env.UI2_CHROMIUM_PATH
            ? { executablePath: process.env.UI2_CHROMIUM_PATH }
            : {}),
        });
        const page = await browser.newPage();
        await page.goto(
          `http://127.0.0.1:${browserServer.httpServer.address().port}/tests/analysis-proposals/reports-fixture.html`,
        );
        await page.evaluate(
          (data) =>
            window.dispatchEvent(
              new CustomEvent('ui8-report', { detail: data }),
            ),
          record,
        );
        await page
          .getByRole('heading', {
            name: '별도 AI 의미 검사 · 자기보고',
            exact: true,
          })
          .waitFor();
        assert.equal(
          (await page
            .getByText('합성 실행 계약만 확인', { exact: false })
            .count()) > 0,
          true,
        );
        const old = structuredClone(record);
        old.active_execution_id = 'f'.repeat(32);
        await page.evaluate(
          (data) =>
            window.dispatchEvent(
              new CustomEvent('ui8-report', { detail: data }),
            ),
          old,
        );
        await page
          .getByRole('heading', {
            name: '별도 AI 의미 검사 · 자기보고',
            exact: true,
          })
          .waitFor({ state: 'detached' });
      } finally {
        await browser?.close();
        await browserServer.close();
      }
      const altered = structuredClone(record);
      altered.current_reports[0].result_ref.run_id = 'f'.repeat(32);
      assert.equal((await verifiedProposalReports(altered)).reports.length, 1);
      const edited = structuredClone(record);
      edited.submission.entities[0].label += 'changed';
      assert.equal((await verifiedProposalReports(edited)).reports.length, 0);
      const stale = structuredClone(record);
      stale.result_links[0].currentness = 'job_cancelled';
      stale.result_links[0].job_cancelled = true;
      assert.equal((await verifiedProposalReports(stale)).reports.length, 1);
      let line = once(lines, 'line');
      child.stdin.write('verify\n');
      assert.equal(JSON.parse((await line)[0]).canonical_unchanged, true);
      line = once(lines, 'line');
      child.stdin.write('slow\n');
      await line;
      const next = {
        ...request,
        requestId: crypto.randomUUID().replaceAll('-', ''),
        expectedStateRevision: record.state_revision,
        candidateRevision: record.candidate_ref.candidate_revision,
        semanticCheck: false,
      };
      const started = await service.start(next);
      assert.equal(started.ok, true, JSON.stringify(started));
      const nextLookup = { ...lookup, executionId: next.requestId };
      await new Promise((done) => setTimeout(done, 300));
      await service.cancel(nextLookup);
      const cancelled = await service.read(nextLookup);
      assert.equal(cancelled.ok, true);
      assert.notEqual(cancelled.data.local.status, 'running');
      line = once(lines, 'line');
      child.stdin.write('verify\n');
      assert.equal(JSON.parse((await line)[0]).canonical_unchanged, true);
    } finally {
      await service?.shutdown();
      child.stdin.write('stop\n');
      child.stdin.end();
      if (child.exitCode === null) await once(child, 'exit');
      lines.close();
    }
  },
);
