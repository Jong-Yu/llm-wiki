import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const transformRoot = await mkdtemp(join(tmpdir(), 'ui2-module-test-'));
const vite = await createServer({
  cacheDir: join(transformRoot, 'vite-cache'),
  configFile: false,
  root: resolve('.'),
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
  await rm(transformRoot, { recursive: true, force: true });
});
const { ProposalDiagnostics } = await vite.ssrLoadModule(
  '/src/renderer/features/review-analysis-proposals/ui/ProposalDiagnostics.tsx',
);
const { AnalysisProposalsApi, proposalRoute } = await vite.ssrLoadModule(
  '/src/main/backend/AnalysisProposalsApi.ts',
);
const { ProposalSession } = await vite.ssrLoadModule(
  '/src/renderer/features/review-analysis-proposals/model/ProposalSession.ts',
);
const {
  proposalSchema,
  canApplyProposal,
  confirmedApplication,
  decisionFieldsSchema,
} = await vite.ssrLoadModule(
  '/src/renderer/features/review-analysis-proposals/model/analysisProposal.schema.ts',
);
const { analysisProposalRequestSchema, parseAnalysisProposalResult } =
  await vite.ssrLoadModule(
    '/src/shared/contracts/analysisProposals.contract.ts',
  );
const hash = 'a'.repeat(64),
  nextHash = 'b'.repeat(64),
  id = 'c'.repeat(32),
  request = 'd'.repeat(32);
const scope = {
  connectionId: 'fixture',
  userId: 'alice',
  tenant: 'alpha',
  profileId: 'all',
  policyRevision: hash,
  permissions: ['read', 'ontology_write', 'ontology_review'],
};
const expectedScope = {
  userId: 'alice',
  tenant: 'alpha',
  profileId: 'all',
  policyRevision: hash,
};
const common = { connectionId: scope.connectionId, expectedScope };
const record = {
  proposal_id: id,
  state_revision: hash,
  input_revision: hash,
  basis_status: 'current',
  basis: {
    target_document: 'target.md',
    documents: [],
    previous: {
      status: 'captured',
      graph: {},
      claims: [],
      source: { content: '원문' },
      source_restoration: 'current_source',
    },
  },
  candidate_ref: { candidate_id: request, candidate_revision: hash },
  submission: {},
  preview_claims: [],
  missing_claims: [],
  decisions: [],
  events: [],
  applications: {},
  submission_schema: {},
  rules_components: {},
  human_approval: false,
  semantic_validation: 'not_run',
};
const submit = {
  ...common,
  operation: 'submit',
  input: {
    proposal_id: id,
    request_id: request,
    expected_state_revision: hash,
    submission: { full: true },
    resolves_decision_ids: [],
    resolution_bindings: [],
  },
};
const read = { ...common, operation: 'read', input: { proposal_id: id } };
const savedReceipt = {
  request_id: request,
  proposal_id: id,
  state: 'complete',
  state_revision: nextHash,
  saved: true,
  receipt: {
    source_revision: hash,
    graph_revision: nextHash,
    candidate_ref: record.candidate_ref,
    human_approval: false,
    cleanup_failures: [],
  },
};
function success(data) {
  return { ok: true, data, traceId: 'e'.repeat(32) };
}

await test('strict contracts reject URL/profile injection and validate restoration evidence', () => {
  assert.equal(
    analysisProposalRequestSchema.safeParse({ ...read, url: 'https://invalid' })
      .success,
    false,
  );
  assert.equal(
    analysisProposalRequestSchema.safeParse({
      ...read,
      input: { ...read.input, profile: 'forged' },
    }).success,
    false,
  );
  assert.equal(proposalRoute(read).path, `analysis-proposals/${id}`);
  assert.deepEqual(
    parseAnalysisProposalResult(success(record)),
    success(record),
  );
  assert.equal(
    decisionFieldsSchema.safeParse({
      action: 'exclude',
      reason: '확인',
      evidence: '',
      replacement: '',
      checkedWhole: false,
    }).success,
    false,
  );
  assert.equal(
    decisionFieldsSchema.safeParse({
      action: 'keep',
      reason: '확인',
      evidence: '원문',
      replacement: '{"evidence":"다른 인용"}',
      checkedWhole: false,
    }).success,
    false,
  );
});
await test('validation matches exact candidate/state; partial receipts never imply success', () => {
  const valid = {
    proposal_id: id,
    state_revision: hash,
    candidate_ref: record.candidate_ref,
    automatic: 'passed',
    semantic: 'not_run',
    human_approval: false,
  };
  assert.equal(canApplyProposal(proposalSchema.parse(record), valid), true);
  assert.equal(
    canApplyProposal(record, { ...valid, state_revision: nextHash }),
    false,
  );
  assert.equal(
    canApplyProposal(
      { ...record, basis_status: 'changed_or_unavailable' },
      valid,
    ),
    false,
  );
  assert.equal(confirmedApplication({ saved: true, receipt: {} }), false);
  assert.equal(
    confirmedApplication({ state: 'complete', saved: null, receipt: null }),
    false,
  );
  assert.equal(confirmedApplication(savedReceipt), true);
});
await test('CAS conflict retains original basis; read cannot silently rebase', async () => {
  const calls = [];
  const session = new ProposalSession(scope, {
    execute: async (value) => {
      calls.push(value);
      return value.operation === 'submit'
        ? { ok: false, error: { code: 'conflict', message: '기준 변경' } }
        : success(
            calls.length === 1
              ? record
              : { ...record, state_revision: nextHash },
          );
    },
  });
  await session.run(read);
  await session.run(submit);
  assert.equal(session.snapshot().blocked, true);
  assert.equal(session.snapshot().record.state_revision, hash);
  await session.run(read);
  assert.equal(session.snapshot().record.state_revision, hash);
  assert.equal(session.snapshot().observed.state_revision, nextHash);
  await session.run(submit);
  assert.equal(calls.length, 3);
  session.adoptObserved();
  assert.equal(session.snapshot().record.state_revision, nextHash);
  assert.equal(session.snapshot().archived[0].state_revision, hash);
});
await test('unknown apply preserves pending; reconciliation only reads exact receipt', async () => {
  const calls = [];
  const session = new ProposalSession(scope, {
    execute: async (value) => {
      calls.push(value);
      if (value.operation === 'read') return success(record);
      if (value.operation === 'receipt')
        return success({
          ...savedReceipt,
          state: 'pending_reconcile',
          saved: null,
          receipt: null,
        });
      return {
        ok: false,
        error: { code: 'outcome_unknown', message: '응답 유실' },
      };
    },
  });
  const apply = {
    ...common,
    operation: 'apply',
    input: {
      proposal_id: id,
      request_id: request,
      expected_state_revision: hash,
      candidate_revision: hash,
    },
  };
  await session.run(read);
  await session.run(apply);
  await session.run(apply);
  await session.reconcile();
  assert.deepEqual(
    calls.map((item) => item.operation),
    ['read', 'apply', 'receipt'],
  );
  assert.deepEqual(session.snapshot().pending, apply);
  assert.equal(confirmedApplication(session.snapshot().receipt), false);
});
await test('older receipt cannot clear a different pending request', async () => {
  const session = new ProposalSession(scope, {
    execute: async (value) =>
      value.operation === 'read'
        ? success(record)
        : value.operation === 'receipt'
          ? success(savedReceipt)
          : {
              ok: false,
              error: { code: 'outcome_unknown', message: '응답 유실' },
            },
  });
  const newer = {
    ...submit,
    input: { ...submit.input, request_id: 'f'.repeat(32) },
  };
  await session.run(read);
  await session.run(newer);
  await session.run({
    ...common,
    operation: 'receipt',
    input: { proposal_id: id, request_id: request },
  });
  assert.deepEqual(session.snapshot().pending, newer);
});
await test('prepare IPC loss retains deterministic lookup ID without repeating POST', async () => {
  const session = new ProposalSession(scope, {
    execute: async () => {
      throw new Error('IPC loss');
    },
  });
  const prepare = {
    ...common,
    operation: 'prepare',
    input: {
      request_id: request,
      document: 'target.md',
      expected_source_revision: hash,
      expected_state_revision: hash,
      context_documents: [],
    },
  };
  await session.run(prepare);
  assert.equal(
    session.snapshot().recovery.proposalId,
    createHash('sha256')
      .update(`alpha:alice:${request}`)
      .digest('hex')
      .slice(0, 32),
  );
  assert.deepEqual(session.snapshot().pending, prepare);
});

await test('unreferenced reports cannot appear as current rule or semantic results', () => {
  const states = ['pass', 'fail', 'not_run', 'not_applicable', 'error'];
  const rendered = renderToStaticMarkup(
    createElement(ProposalDiagnostics, {
      report: {
        validation_report: {
          automatic: 'passed',
          rule_results: states.map((status, index) => ({
            rule_id: `R-A0${index + 1}`,
            status,
            checker: 'server',
            reason: `reason-${status}`,
          })),
        },
        diagnostics: {
          report: {
            reviewer_kind: 'separate_ai',
            rule_results: [
              { rule_id: 'R-S01', status: 'not_run', reason: 'input missing' },
            ],
          },
          human_approval: false,
        },
      },
    }),
  );
  for (const state of states)
    assert.equal(rendered.includes(`reason-${state}`), false);
  assert.ok(
    rendered.includes('실행·결과·후보 참조가 있는 검사 보고가 없습니다.'),
  );
  assert.ok(rendered.includes('사람 승인이 아닙니다'));
});

await test('protected proposal recovery rechecks server, preserves original CAS and never replays a pending mutation', async () => {
  const oldWindow = globalThis.window;
  let entry = null;
  let activeConnection = scope.connectionId;
  globalThis.window = {
    wiki: {
      recovery: {
        execute: async (request) => {
          if (request.connectionId !== activeConnection)
            return {
              ok: false,
              error: { code: 'scope_changed', message: 'scope changed' },
            };
          if (request.operation === 'list')
            return {
              ok: true,
              data: { entries: entry ? [entry] : [], cleanupWarningCount: 0 },
            };
          if (request.expectedRevision !== (entry?.revision ?? null))
            return {
              ok: false,
              error: { code: 'conflict', message: 'conflict' },
            };
          entry = {
            key: request.key,
            kind: request.kind,
            payload: request.payload,
            revision: createHash('sha256')
              .update(request.payload)
              .digest('hex'),
            savedAt: new Date().toISOString(),
          };
          return {
            ok: true,
            data: { entries: [entry], cleanupWarningCount: 0 },
          };
        },
      },
    },
  };
  const calls = [];
  const gateway = {
    execute: async (request) => {
      calls.push(request.operation);
      return request.operation === 'read'
        ? success(record)
        : { ok: false, error: { code: 'outcome_unknown', message: 'lost' } };
    },
  };
  try {
    const before = new ProposalSession(scope, gateway);
    await before.initializeRecovery('test-proposal');
    await before.run(read);
    before.forms.submit.set('basis', {
      whole: '{broken pending edit',
      resolves: '',
      bindings: '[]',
    });
    before.forms.completion.set('basis', {
      reason: 'old check',
      reviewed: [hash],
      confirmed: true,
    });
    await before.run(submit);
    await before.persist();
    await new Promise((done) => setTimeout(done, 250));
    const retained = JSON.parse(entry.payload);
    assert.equal(retained.pending.input.expected_state_revision, hash);
    activeConnection = 'after-restart';
    const restored = new ProposalSession(
      { ...scope, connectionId: activeConnection },
      gateway,
    );
    await restored.initializeRecovery('test-proposal');
    assert.deepEqual(calls, ['read', 'submit', 'read']);
    assert.equal(restored.snapshot().blocked, true);
    assert.equal(
      restored.snapshot().pending.input.expected_state_revision,
      hash,
    );
    assert.equal(
      restored.forms.submit.get('basis').whole,
      '{broken pending edit',
    );
    assert.equal(restored.forms.completion.get('basis').confirmed, false);
    assert.equal(restored.snapshot().validation, null);
    assert.equal(restored.snapshot().record.state_revision, hash);
  } finally {
    globalThis.window = oldWindow;
  }
});

await test(
  'actual isolated HTTP API via main adapter: missing recovery, apply, new review, completion and source conflict',
  { timeout: 60000 },
  async () => {
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
    const lines = createInterface({ input: server.stdout });
    let stderr = '';
    server.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const ready = Promise.race([
      once(lines, 'line').then(([line]) => JSON.parse(line)),
      once(server, 'exit').then(() => {
        throw new Error(`Fixture startup failed: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify(tokens) + '\n');
    try {
      const detail = await ready;
      const base = `http://127.0.0.1:${detail.port}/proxy/api/v1/tenants/alpha`;
      const fetchData = async (path, method = 'GET', body) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            Authorization: `Bearer ${tokens.alice}`,
            'Content-Type': 'application/json',
          },
          ...(body
            ? { body: JSON.stringify({ ...body, profile: 'all' }) }
            : {}),
        });
        const value = await response.json();
        assert.ok(
          response.ok,
          `Fixture HTTP ${response.status}: ${JSON.stringify(value)}`,
        );
        return value.data;
      };
      let current;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          current = await fetchData(
            '/documents/knowledge?document=Guide-01.md&profile=all',
          );
          break;
        } catch (error) {
          if (attempt === 49) throw error;
          await new Promise((done) => setTimeout(done, 100));
        }
      }
      const context = {
        active: {
          connectionId: 'fixture',
          serverUrl: `http://127.0.0.1:${detail.port}/proxy/api/v1/`,
          userId: 'alice',
          policyRevision: current.access.policy_revision,
          workspaces: [
            {
              id: 'alpha',
              permissions: scope.permissions,
              profiles: [{ id: 'all', domain: null, viewpoint: null }],
            },
          ],
        },
        selection: { tenant: 'alpha', profile: 'all' },
        token: tokens.alice,
      };
      const api = new AnalysisProposalsApi({
        onScopeChanged: () => {},
        analysisContext: async () => context,
        isAnalysisCurrent: () => true,
        invalidateApiScope: () => {},
      });
      const apiScope = {
        connectionId: 'fixture',
        expectedScope: {
          ...expectedScope,
          policyRevision: current.access.policy_revision,
        },
      };
      const execute = async (operation, input) => {
        const result = await api.execute({ ...apiScope, operation, input });
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.data;
      };
      const whole = JSON.parse(
        execFileSync(
          resolve('../.venv/bin/python'),
          [
            '-B',
            '-c',
            'import json; from core.tests.modules.test_ontology import ontology_v3_fixture; source,entities,relations,candidates,attributes=ontology_v3_fixture(); print(json.dumps(dict(schema_version=3,entities=entities,relations=relations,relation_candidates=candidates,attributes=attributes)))',
          ],
          { cwd: resolve('..'), encoding: 'utf8' },
        ),
      );
      for (const collection of [
        'relations',
        'attributes',
        'relation_candidates',
      ])
        for (const claim of whole[collection])
          claim.qualifiers = {
            polarity: 'positive',
            modality: 'asserted',
            condition: null,
            scope: null,
            time: null,
            ...claim.qualifiers,
          };
      let proposal = await execute('prepare', {
        request_id: randomBytes(16).toString('hex'),
        document: 'Guide-01.md',
        expected_source_revision: current.source_revision,
        expected_state_revision: current.state_revision,
        context_documents: [],
      });
      proposalSchema.parse(proposal);
      const pid = proposal.proposal_id;
      proposal = await execute('submit', {
        proposal_id: pid,
        request_id: randomBytes(16).toString('hex'),
        expected_state_revision: proposal.state_revision,
        submission: {
          ...whole,
          relations: [],
          attributes: [],
          relation_candidates: [],
        },
        resolves_decision_ids: [],
        resolution_bindings: [],
      });
      assert.ok(proposal.missing_claims.length > 1);
      const missing = proposal.missing_claims.find(
        (claim) =>
          claim.collection === 'relations' &&
          claim.value.subject === whole.relations[0].subject &&
          claim.value.object === whole.relations[0].object &&
          claim.value.predicate === whole.relations[0].predicate,
      );
      const excluded = proposal.missing_claims.find(
        (claim) => claim.claim_id !== missing.claim_id,
      );
      proposal = await execute('decide', {
        proposal_id: pid,
        request_id: randomBytes(16).toString('hex'),
        expected_state_revision: proposal.state_revision,
        candidate_revision: proposal.candidate_ref.candidate_revision,
        old_claim_id: excluded.claim_id,
        action: 'exclude',
        reason: '이번 비교 범위만 제외',
        checked_whole: true,
        evidence: '',
        replacement: null,
      });
      proposal = await execute('decide', {
        proposal_id: pid,
        request_id: randomBytes(16).toString('hex'),
        expected_state_revision: proposal.state_revision,
        candidate_revision: proposal.candidate_ref.candidate_revision,
        old_claim_id: missing.claim_id,
        action: 'keep',
        reason: '격리 시험의 인용 복구',
        checked_whole: true,
        evidence: whole.relations[0].evidence,
        replacement: whole.relations[0],
      });
      assert.equal(
        proposal.decisions.at(-1).recovery_status,
        'draft_only_requires_whole_apply_then_new_review',
      );
      const reextractOld = proposal.missing_claims.find(
        (claim) =>
          claim.collection === 'relations' &&
          claim.value.subject === whole.relations[1].subject &&
          claim.value.predicate === whole.relations[1].predicate,
      );
      const decisionId = randomBytes(16).toString('hex');
      proposal = await execute('decide', {
        proposal_id: pid,
        request_id: decisionId,
        expected_state_revision: proposal.state_revision,
        candidate_revision: proposal.candidate_ref.candidate_revision,
        old_claim_id: reextractOld.claim_id,
        action: 'reextract',
        reason: '새 인용의 명시 대응 검증',
        checked_whole: false,
        evidence: '',
        replacement: null,
      });
      whole.relations[1].evidence = proposal.basis.documents.find(
        (document) => document.document === 'Guide-01.md',
      ).source.content;
      proposal = await execute('submit', {
        proposal_id: pid,
        request_id: randomBytes(16).toString('hex'),
        expected_state_revision: proposal.state_revision,
        submission: whole,
        resolves_decision_ids: [],
        resolution_bindings: [],
      });
      const linkedClaim = proposal.preview_claims.find(
        (claim) =>
          claim.collection === 'relations' &&
          claim.value.subject === whole.relations[1].subject &&
          claim.value.predicate === whole.relations[1].predicate,
      );
      assert.notEqual(linkedClaim.claim_id, reextractOld.claim_id);
      proposal = await execute('submit', {
        proposal_id: pid,
        request_id: randomBytes(16).toString('hex'),
        expected_state_revision: proposal.state_revision,
        submission: whole,
        resolves_decision_ids: [decisionId],
        resolution_bindings: [
          {
            decision_id: decisionId,
            new_claim_id: linkedClaim.claim_id,
            reason: '같은 관계의 새 인용을 대조',
          },
        ],
      });
      const validated = await execute('validate', { proposal_id: pid });
      assert.equal(canApplyProposal(proposal, validated), true);
      const appliedRequest = randomBytes(16).toString('hex');
      const applied = await execute('apply', {
        proposal_id: pid,
        request_id: appliedRequest,
        expected_state_revision: proposal.state_revision,
        candidate_revision: proposal.candidate_ref.candidate_revision,
      });
      assert.equal(confirmedApplication(applied), true);
      assert.equal(
        (
          await execute('receipt', {
            proposal_id: pid,
            request_id: appliedRequest,
          })
        ).saved,
        true,
      );
      proposal = await execute('read', { proposal_id: pid });
      current = await fetchData(
        '/documents/knowledge?document=Guide-01.md&profile=all',
      );
      assert.ok(
        current.claims.every((claim) => claim.decision === 'unreviewed'),
      );
      const completionInput = {
        proposal_id: pid,
        request_id: randomBytes(16).toString('hex'),
        expected_state_revision: proposal.state_revision,
        expected_review_state_revision: current.state_revision,
        reviewed_claim_ids: [missing.claim_id, linkedClaim.claim_id],
        reason: '선택 범위 완료',
      };
      const notReviewed = await api.execute({
        ...apiScope,
        operation: 'complete',
        input: completionInput,
      });
      assert.equal(notReviewed.ok, false);
      await fetchData('/documents/reviews', 'POST', {
        document: 'Guide-01.md',
        claim_id: missing.claim_id,
        expected_state_revision: current.state_revision,
        action: 'accept',
        reason: '격리 시험의 새 세대 실제 검토',
      });
      current = await fetchData(
        '/documents/knowledge?document=Guide-01.md&profile=all',
      );
      await fetchData('/documents/reviews', 'POST', {
        document: 'Guide-01.md',
        claim_id: linkedClaim.claim_id,
        expected_state_revision: current.state_revision,
        action: 'accept',
        reason: '격리 시험의 새 claim 실제 검토',
      });
      current = await fetchData(
        '/documents/knowledge?document=Guide-01.md&profile=all',
      );
      const completed = await execute('complete', {
        ...completionInput,
        request_id: randomBytes(16).toString('hex'),
        expected_review_state_revision: current.state_revision,
      });
      assert.equal(completed.events.at(-1).other_claims_approved, false);
      const preserved = await fetchData(
        '/documents/content?document=Guide-01.md&profile=all',
      );
      const stale = await execute('prepare', {
        request_id: randomBytes(16).toString('hex'),
        document: 'Guide-01.md',
        expected_source_revision: current.source_revision,
        expected_state_revision: current.state_revision,
        context_documents: [],
        submission: whole,
      });
      await fetchData('/documents/content', 'PUT', {
        document: 'Guide-01.md',
        expected_revision: preserved.revision,
        content: preserved.content + '\n격리 시험 원문 변경\n',
      });
      const conflict = await api.execute({
        ...apiScope,
        operation: 'apply',
        input: {
          proposal_id: stale.proposal_id,
          request_id: randomBytes(16).toString('hex'),
          expected_state_revision: stale.state_revision,
          candidate_revision: stale.candidate_ref.candidate_revision,
        },
      });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.error.code, 'conflict');
      const kept = await execute('read', { proposal_id: stale.proposal_id });
      assert.deepEqual(kept.submission, whole);
      assert.equal(kept.basis_status, 'changed_or_unavailable');
    } finally {
      lines.close();
      if (server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill('SIGINT');
        await exited;
      }
    }
  },
);
