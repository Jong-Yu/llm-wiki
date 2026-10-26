import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const aliases = {
  '@contracts/': 'src/shared/contracts/',
  '@renderer/': 'src/renderer/',
  '@main/': 'src/main/',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    for (const [prefix, path] of Object.entries(aliases))
      if (specifier.startsWith(prefix))
        specifier = pathToFileURL(
          resolve(root, path, specifier.slice(prefix.length)),
        ).href;
    if (
      (specifier.startsWith('file:') || specifier.startsWith('.')) &&
      context.parentURL
    ) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path) || ['.contract', '.api'].includes(extname(path))) {
        if (existsSync(path + '.ts'))
          specifier = pathToFileURL(path + '.ts').href;
        else if (existsSync(path + '/index.ts'))
          specifier = pathToFileURL(path + '/index.ts').href;
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts'))
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      };
    return next(url, context);
  },
});
const contract =
  await import('../src/shared/contracts/resultDrafts.contract.ts');
const { ResultDraftService } =
  await import('../src/main/backend/ResultDraftService.ts');
const model =
  await import('../src/renderer/features/manage-result-drafts/model/resultDrafts.ts');
const api =
  await import('../src/renderer/features/manage-result-drafts/api/resultDrafts.api.ts');
after(() => hooks.deregister());
const id = 'a'.repeat(32),
  req = 'b'.repeat(32),
  revision = 'c'.repeat(64),
  observed = 'd'.repeat(64);
const scope = {
  userId: 'alice',
  tenant: 'alpha',
  profileId: 'business',
  policyRevision: revision,
};
const session = {
  ...scope,
  connectionId: 'connection',
  permissions: ['read', 'write', 'result_write'],
};
const access = {
  user_id: 'alice',
  tenant: 'alpha',
  profile_id: 'business',
  domain: null,
  viewpoint: null,
  policy_revision: revision,
};
const base = { connectionId: session.connectionId, expectedScope: scope };
const draft = {
  revision,
  draft: { title: '초안', content: '원문 편집' },
  rendered_content: '전체 근거 포함',
  rendered_size_bytes: 20,
  can_apply_size: true,
  basis_observation: {
    status: 'changed',
    observation_revision: observed,
    documents: [],
    originals: [],
    profile_changed: false,
  },
  record: {
    id,
    kind: 'result-drafts',
    tenant: 'alpha',
    user_id: 'alice',
    data: {
      title: '원래 제목',
      content: '원래 생성문',
      original_generated_title: '원래 제목',
      original_generated_content: '원래 생성문',
      source_result_id: id,
      source_result_revision: revision,
      basis: { frozen: '전체 원문', unknown_future: [1, 2] },
      answer_provenance: { citation: '당시 인용' },
      origin: 'client_reported',
      human_approval: false,
    },
    events: [],
    requests: { [req]: revision },
  },
};
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
});
function service(permissions = session.permissions) {
  const context = {
    active: {
      connectionId: 'connection',
      userId: 'alice',
      policyRevision: revision,
      serverUrl: 'http://127.0.0.1/api/v1/',
      workspaces: [
        {
          id: 'alpha',
          permissions,
          profiles: [{ id: 'business', domain: null, viewpoint: null }],
        },
      ],
    },
    selection: { tenant: 'alpha', profile: 'business' },
    token: 'isolated-test-secret',
  };
  const connection = {
    onScopeChanged() {},
    async analysisContext() {
      return context;
    },
    isAnalysisCurrent() {
      return true;
    },
    invalidateApiScope() {},
  };
  return { instance: new ResultDraftService(connection), connection };
}
function response(data) {
  return new Response(
    JSON.stringify({ data: { ...data, access }, meta: { trace_id: req } }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
function state() {
  return {
    ...model.emptyDraftState(),
    selected: draft,
    form: draft.draft,
    target: { document: 'Result.md', content: 'old', revision },
    compared: true,
    acknowledged: observed,
  };
}

void test('strict IPC rejects tenant injection and unsafe path; revision fields are mandatory', () => {
  assert.equal(
    contract.resultDraftRequestSchema.safeParse({
      ...base,
      operation: 'create',
      input: { request_id: req, saved_result_id: id, tenant: 'other' },
    }).success,
    false,
  );
  const apply = {
    ...base,
    operation: 'apply',
    input: {
      draft_id: id,
      request_id: req,
      expected_revision: revision,
      document: '../escape.md',
      expected_document_revision: null,
      expected_basis_observation: observed,
      acknowledge_changed_basis: true,
    },
  };
  assert.equal(
    contract.resultDraftRequestSchema.safeParse(apply).success,
    false,
  );
  apply.input.document = 'Result.md';
  assert.equal(
    contract.resultDraftRequestSchema.safeParse(apply).success,
    true,
  );
  delete apply.input.expected_document_revision;
  assert.equal(
    contract.resultDraftRequestSchema.safeParse(apply).success,
    false,
  );
});
void test('main sends exact CAS + basis, omits route ID; application receipt needs only read', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url:
        url instanceof URL ? url.href : typeof url === 'string' ? url : url.url,
      ...init,
    });
    return response({ saved: true });
  };
  const full = service();
  const input = {
    draft_id: id,
    request_id: req,
    expected_revision: revision,
    document: 'Result.md',
    expected_document_revision: revision,
    expected_basis_observation: observed,
    acknowledge_changed_basis: true,
  };
  assert.equal(
    (await full.instance.execute({ ...base, operation: 'apply', input })).ok,
    true,
  );
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.draft_id, undefined);
  assert.equal(payload.profile, 'business');
  assert.equal(payload.expected_document_revision, revision);
  assert.equal(payload.expected_basis_observation, observed);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(
    (
      await service(['read']).instance.execute({
        ...base,
        operation: 'applicationReceipt',
        input: { draft_id: id, request_id: req },
      })
    ).ok,
    true,
  );
  assert.equal(calls[1].method, 'GET');
  assert.match(
    calls[1].url,
    new RegExp(`/applications/${req}\\?profile=business$`),
  );
  assert.equal(
    (
      await service(['read', 'result_write']).instance.execute({
        ...base,
        operation: 'apply',
        input,
      })
    ).error.code,
    'forbidden',
  );
  assert.equal(calls.length, 2);
});
void test('main maps lost response to unknown once, keeps conflict/busy/permission distinct and hides server details', async () => {
  let calls = 0;
  const instance = service().instance;
  const command = {
    ...base,
    operation: 'edit',
    input: {
      draft_id: id,
      request_id: req,
      expected_revision: revision,
      title: '제목',
      content: '본문',
    },
  };
  globalThis.fetch = async () => {
    calls++;
    throw new Error('isolated-test-secret');
  };
  assert.equal((await instance.execute(command)).error.code, 'outcome_unknown');
  assert.equal(calls, 1);
  for (const [status, code, expected] of [
    [409, 'personal_conflict', 'conflict'],
    [503, 'storage_busy', 'storage_busy'],
    [403, 'access_denied', 'forbidden'],
    [500, 'broken', 'outcome_unknown'],
  ]) {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code,
            details: { cleanup_failures: ['private path'] },
            message: 'isolated-test-secret',
          },
          meta: { trace_id: req },
        }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    const result = await instance.execute(command);
    assert.equal(result.error.code, expected);
    assert.equal(result.error.cleanupWarningCount, 1);
    assert.equal(
      JSON.stringify(result).includes('isolated-test-secret'),
      false,
    );
  }
});
void test('main rejects stale expected scope before sending and changed scope after commit is unknown', async () => {
  let calls = 0;
  const { instance, connection } = service();
  globalThis.fetch = async () => {
    calls++;
    connection.isAnalysisCurrent = () => false;
    return response({});
  };
  assert.equal(
    (
      await instance.execute({
        ...base,
        expectedScope: { ...scope, tenant: 'other' },
        operation: 'list',
        input: { cursor: null, limit: 20 },
      })
    ).error.code,
    'scope_changed',
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await instance.execute({
        ...base,
        operation: 'create',
        input: { request_id: req, saved_result_id: id },
      })
    ).error.code,
    'outcome_unknown',
  );
  assert.equal(calls, 1);
});
void test('apply requires observed acknowledgement, full UTF-8 size, saved editor and compared target', () => {
  assert.equal(model.canApplyDraft(state(), session.permissions), true);
  for (const change of [
    { acknowledged: null },
    { compared: false },
    { target: null },
    { pending: { requestId: req } },
    { conflict: true },
    { form: { ...draft.draft, content: 'unsaved' } },
  ])
    assert.equal(
      model.canApplyDraft({ ...state(), ...change }, session.permissions),
      false,
    );
  assert.equal(
    model.canApplyDraft(
      {
        ...state(),
        selected: { ...draft, rendered_size_bytes: 1024 * 1024 + 1 },
      },
      session.permissions,
    ),
    false,
  );
  assert.equal(
    model.canApplyDraft(
      {
        ...state(),
        selected: {
          ...draft,
          basis_observation: {
            ...draft.basis_observation,
            observation_revision: revision,
          },
        },
      },
      session.permissions,
    ),
    false,
  );
  assert.equal(model.canApplyDraft(state(), ['read', 'result_write']), false);
});
void test('record and receipt validation preserve all frozen evidence; never infer success from matching text', () => {
  const parsed = model.draftDetailSchema.parse(draft);
  assert.deepEqual(parsed.record.data.basis, draft.record.data.basis);
  assert.equal(
    api.confirmedDraftId(parsed, session, { requestId: req, draftId: id }),
    id,
  );
  assert.equal(
    api.confirmedDraftId(parsed, session, { requestId: id, draftId: id }),
    null,
  );
  const pending = {
    operation: 'apply',
    requestId: req,
    draftId: id,
    document: 'Result.md',
    revision,
  };
  const value = {
    record_id: id,
    request_id: req,
    state: 'pending_reconcile',
    saved: null,
    receipt: null,
    cleanup_failures: [],
  };
  assert.equal(api.confirmedApplication(value, pending).saved, null);
  assert.equal(
    api.confirmedApplication({ ...value, saved: true }, pending),
    null,
  );
  const saved = {
    ...value,
    saved: true,
    receipt: {
      draft_id: id,
      draft_revision: revision,
      document: 'Result.md',
      source_revision: observed,
      history_id: null,
      changed: true,
    },
    cleanup_failures: ['cleanup warning'],
  };
  assert.equal(
    api.confirmedApplication(saved, pending).cleanup_failures.length,
    1,
  );
  assert.equal(
    api.confirmedApplication(saved, { ...pending, document: 'Else.md' }),
    null,
  );
});
void test('target 404 alone means create; 403 is never treated as missing document', async () => {
  const snapshot = {
    status: 'connected',
    connectionId: 'connection',
    userId: 'alice',
    policyRevision: revision,
    selection: { tenant: 'alpha', profile: 'business' },
    workspaces: [{ id: 'alpha', permissions: session.permissions }],
  };
  globalThis.window = {
    wiki: {
      connection: {
        async getState() {
          return { ok: true, data: snapshot };
        },
      },
      documents: {
        async content() {
          return {
            ok: false,
            error: { code: 'not_found', status: 404, message: 'missing' },
          };
        },
      },
    },
  };
  assert.deepEqual((await api.readDraftTarget(session, 'New.md')).data, {
    document: 'New.md',
    revision: null,
    content: '',
  });
  window.wiki.documents.content = async () => ({
    ok: false,
    error: { code: 'forbidden', status: 403, message: 'denied' },
  });
  assert.equal((await api.readDraftTarget(session, 'New.md')).ok, false);
});

void test('actual isolated API: create/edit/frozen evidence, CAS, changed basis, lost apply response and read-only receipt', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const { randomBytes } = await import('node:crypto');
  globalThis.fetch = realFetch;
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
    workspace: true,
  };
  const child = spawn(
    resolve(root, '../.venv/bin/python'),
    ['-B', resolve(root, 'tests/fixtures/connection_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const ready = Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(() => {
      throw new Error('Isolated server failed: ' + stderr.slice(0, 300));
    }),
  ]);
  child.stdin.end(JSON.stringify(tokens) + '\n');
  try {
    const details = await ready;
    const origin = `http://127.0.0.1:${details.port}`;
    const endpoint = `${origin}/api/v1/tenants/alpha/`;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if ((await realFetch(origin + '/fixture-stats')).ok) break;
      } catch {
        /* server startup */
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    const requestId = () => randomBytes(16).toString('hex');
    async function http(path, method = 'GET', body) {
      const result = await realFetch(endpoint + path, {
        method,
        headers: {
          Authorization: `Bearer ${tokens.alice}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(result.ok, `actual API ${method} ${path}: ${result.status}`);
      return (await result.json()).data;
    }
    const saved = await http('saved-results', 'POST', {
      request_id: requestId(),
      title: '원래 제목',
      content: '원래 생성문',
      profile: 'business',
      context_request: { documents: ['Guide-01.md'], profile: 'business' },
    });
    const actualScope = {
      userId: saved.access.user_id,
      tenant: saved.access.tenant,
      profileId: saved.access.profile_id,
      policyRevision: saved.access.policy_revision,
    };
    const actualSession = {
      ...actualScope,
      connectionId: 'connection',
      permissions: session.permissions,
    };
    const context = {
      active: {
        connectionId: 'connection',
        userId: actualScope.userId,
        policyRevision: actualScope.policyRevision,
        serverUrl: origin + '/api/v1/',
        workspaces: [
          {
            id: 'alpha',
            permissions: session.permissions,
            profiles: [
              {
                id: 'business',
                domain: saved.access.domain,
                viewpoint: saved.access.viewpoint,
              },
            ],
          },
        ],
      },
      selection: { tenant: 'alpha', profile: 'business' },
      token: tokens.alice,
    };
    const connection = {
      onScopeChanged() {},
      async analysisContext() {
        return context;
      },
      isAnalysisCurrent() {
        return true;
      },
      invalidateApiScope() {},
    };
    const instance = new ResultDraftService(connection);
    const execute = async (operation, input) =>
      instance.execute({
        connectionId: 'connection',
        expectedScope: actualScope,
        operation,
        input,
      });
    const created = await execute('create', {
      request_id: requestId(),
      saved_result_id: saved.record.id,
    });
    assert.equal(created.ok, true);
    const draftId = created.data.data.record.id;
    const first = model.draftDetailSchema.parse(
      (await execute('read', { draft_id: draftId })).data.data,
    );
    const editId = requestId();
    const edited = await execute('edit', {
      draft_id: draftId,
      request_id: editId,
      expected_revision: first.revision,
      title: '편집 제목',
      content: '사용자 편집문',
    });
    assert.equal(
      api.confirmedDraftId(edited.data.data, actualSession, {
        requestId: editId,
        draftId,
      }),
      draftId,
    );
    const stale = await execute('edit', {
      draft_id: draftId,
      request_id: requestId(),
      expected_revision: first.revision,
      title: '과거',
      content: '덮어쓰기 시도',
    });
    assert.equal(stale.error.code, 'conflict');
    const current = model.draftDetailSchema.parse(
      (await execute('read', { draft_id: draftId })).data.data,
    );
    assert.equal(current.draft.content, '사용자 편집문');
    assert.equal(current.record.data.original_generated_content, '원래 생성문');
    assert.deepEqual(current.record.data.basis, first.record.data.basis);
    const source = await http(
      'documents/content?document=Guide-01.md&profile=business',
    );
    await http('documents/content', 'PUT', {
      profile: 'business',
      document: 'Guide-01.md',
      expected_revision: source.revision,
      content: source.content + '\nChanged after answer\n',
    });
    const applyId = requestId();
    let input = {
      draft_id: draftId,
      request_id: applyId,
      expected_revision: current.revision,
      document: 'Result-Draft.md',
      expected_document_revision: null,
      expected_basis_observation:
        current.basis_observation.observation_revision,
      acknowledge_changed_basis: false,
    };
    assert.equal((await execute('apply', input)).error.code, 'conflict');
    const changed = model.draftDetailSchema.parse(
      (await execute('read', { draft_id: draftId })).data.data,
    );
    assert.equal(changed.basis_observation.status, 'changed');
    input = {
      ...input,
      request_id: requestId(),
      expected_basis_observation:
        changed.basis_observation.observation_revision,
      acknowledge_changed_basis: true,
    };
    let mutations = 0;
    globalThis.fetch = async (url, init) => {
      const result = await realFetch(url, init);
      if (
        init?.method === 'POST' &&
        (url instanceof URL
          ? url.href
          : typeof url === 'string'
            ? url
            : url.url
        ).endsWith('/applications')
      ) {
        mutations++;
        await result.arrayBuffer();
        throw new Error('simulated response lost after actual commit');
      }
      return result;
    };
    assert.equal((await execute('apply', input)).error.code, 'outcome_unknown');
    globalThis.fetch = realFetch;
    const receipt = await execute('applicationReceipt', {
      draft_id: draftId,
      request_id: input.request_id,
    });
    assert.equal(
      api.confirmedApplication(receipt.data.data, {
        requestId: input.request_id,
        draftId,
        document: input.document,
        revision: current.revision,
      }).saved,
      true,
    );
    assert.equal(mutations, 1);
    const document = await http(
      'documents/content?document=Result-Draft.md&profile=business',
    );
    assert.equal(document.content, changed.rendered_content);
    await realFetch(origin + '/fixture-workspace-mode/read-only', {
      method: 'POST',
    });
    const readonlyReceipt = await http(
      `result-drafts/${draftId}/applications/${input.request_id}?profile=business`,
    );
    assert.equal(readonlyReceipt.saved, true);
  } finally {
    globalThis.fetch = realFetch;
    lines.close();
    if (child.exitCode === null) {
      child.kill('SIGINT');
      await once(child, 'exit');
    }
  }
});
