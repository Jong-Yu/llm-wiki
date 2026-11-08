import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const result = await build({
  configFile: false,
  logLevel: 'silent',
  root,
  resolve: {
    alias: {
      '@contracts': resolve(root, 'src/shared/contracts'),
      '@renderer': resolve(root, 'src/renderer'),
    },
  },
  ssr: { noExternal: true },
  build: {
    write: false,
    ssr: fileURLToPath(
      new URL('./ontologyExploration.queries.ts', import.meta.url),
    ),
    rolldownOptions: { output: { format: 'es' } },
  },
});
const output = Array.isArray(result) ? result[0].output : result.output;
const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
assert.ok(chunk);
const {
  createOntologyQueryClient,
  ontologySearchOptions,
  queryOntologyNeighbors,
  OntologyQueryError,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
);

const revision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
const scope = {
  connectionId: 'connection-a',
  userId: 'reader',
  tenant: 'space-a',
  profileId: 'default',
  policyRevision: revision,
  accessRevision: revision,
  permissions: ['read'],
};
const input = { text: '예약', kind: 'concept', limit: 20 };

function fixture() {
  const client = createOntologyQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, gcTime: 50 },
  });
  const state = {
    scope: { ...scope },
    calls: [],
    mode: 'valid',
    release: null,
    started: null,
  };
  const access = () => ({
    user_id: state.scope.userId,
    tenant: state.scope.tenant,
    profile_id: state.scope.profileId,
    domain: null,
    viewpoint: null,
    policy_revision: state.scope.policyRevision,
    access_revision: state.scope.accessRevision,
  });
  const page = () => ({
    items: [],
    index_revision: state.indexRevision ?? revision,
    total: 0,
    next_cursor: null,
    coverage: {
      complete: false,
      skipped: [{ document: 'broken.md', code: 'unavailable' }],
      truncated: true,
    },
    access: access(),
  });
  globalThis.window = {
    wiki: {
      connection: {
        getState: async () => ({
          ok: true,
          data: {
            status: 'connected',
            ...state.scope,
            selection: {
              tenant: state.scope.tenant,
              profile: state.scope.profileId,
            },
            workspaces: [
              {
                id: state.scope.tenant,
                permissions: state.scope.permissions,
                profiles: [{ id: state.scope.profileId }],
              },
            ],
          },
        }),
      },
      workspace: {
        execute: async (request) => {
          state.calls.push(request);
          if (state.mode === 'pending')
            await new Promise((done) => {
              state.release = done;
              state.started?.();
            });
          if (state.mode === 'unavailable' || state.mode === 'forbidden')
            return {
              ok: false,
              error: {
                code: state.mode,
                message: '합성 실패',
                status: state.mode === 'forbidden' ? 403 : 503,
              },
            };
          const data =
            request.operation === 'ontologySearch'
              ? page()
              : {
                  concepts: [],
                  edges: [],
                  document: {
                    document: request.input.document,
                    kind: 'document',
                    reference: request.input.document,
                    source_revision: revision,
                    graph_revision: revision,
                    review_revision: null,
                    history_revision: revision,
                    state_revision: request.input.expected_state_revision,
                    status: 'ready',
                  },
                  entity_id: request.input.entity_id,
                  index_revision: revision,
                  total: 0,
                  next_cursor: null,
                  coverage: page().coverage,
                  access: access(),
                };
          if (state.mode === 'malformed') data.total = 'wrong';
          return {
            ok: true,
            data: { operation: request.operation, access: state.scope, data },
          };
        },
      },
    },
  };
  return { client, state };
}

await test('같은 검색은 진행 중 요청과 15초 내 결과를 공유하고 부분 조회 정보를 유지한다', async () => {
  const { client, state } = fixture();
  try {
    const options = ontologySearchOptions(scope, input);
    const [a, b] = await Promise.all([
      client.infiniteQuery(options),
      client.infiniteQuery(options),
    ]);
    assert.equal(state.calls.length, 1);
    assert.deepEqual(a, b);
    assert.equal(a.pages[0].coverage.truncated, true);
    assert.deepEqual(a.pages[0].coverage.skipped, [
      { document: 'broken.md', code: 'unavailable' },
    ]);
    await client.infiniteQuery(options);
    assert.equal(state.calls.length, 1);
    client.setQueryData(options.queryKey, a, {
      updatedAt: Date.now() - 16_000,
    });
    await client.infiniteQuery(options);
    assert.equal(state.calls.length, 2);
    await client.invalidateQueries({ refetchType: 'none' });
    await client.infiniteQuery(options);
    assert.equal(state.calls.length, 3);
  } finally {
    client.clear();
  }
});

await test('이전 검색 캐시로 돌아가도 최신 서버 색인 관측을 과거로 되돌리지 않는다', async () => {
  const { client, state } = fixture();
  const observed = [];
  try {
    const first = ontologySearchOptions(scope, input, (value) =>
      observed.push(value),
    );
    await client.infiniteQuery(first);
    state.indexRevision = nextRevision;
    await client.infiniteQuery(
      ontologySearchOptions(scope, { ...input, text: '결제' }, (value) =>
        observed.push(value),
      ),
    );
    const old = await client.infiniteQuery(first);
    assert.equal(old.pages[0].index_revision, revision);
    assert.deepEqual(observed, [revision, nextRevision]);
    assert.equal(state.calls.length, 2);
  } finally {
    client.clear();
  }
});

await test('검색·문서·종류·페이지 크기와 연결/사용자/공간/관점/접근 판본을 다른 키로 분리한다', async () => {
  const { client, state } = fixture();
  try {
    for (const change of [
      {},
      { text: '결제' },
      { document: 'a.md' },
      { kind: 'document' },
      { limit: 5 },
    ])
      await client.infiniteQuery(
        ontologySearchOptions(scope, { ...input, ...change }),
      );
    assert.equal(state.calls.length, 5);
    for (const change of [
      { connectionId: 'other' },
      { userId: 'other' },
      { tenant: 'other' },
      { profileId: 'other' },
      { accessRevision: nextRevision },
    ]) {
      state.scope = { ...scope, ...change };
      await client.infiniteQuery(ontologySearchOptions(state.scope, input));
    }
    assert.equal(state.calls.length, 10);
    const legacy = { ...scope, accessRevision: undefined };
    assert.notDeepEqual(
      ontologySearchOptions(legacy, input).queryKey,
      ontologySearchOptions({ ...legacy, policyRevision: nextRevision }, input)
        .queryKey,
    );
  } finally {
    client.clear();
  }
});

await test('실패·손상 응답을 성공 캐시로 재사용하거나 자동 재시도하지 않는다', async () => {
  const { client, state } = fixture();
  try {
    const options = ontologySearchOptions(scope, input);
    state.mode = 'unavailable';
    await assert.rejects(
      client.infiniteQuery(options),
      (error) =>
        error instanceof OntologyQueryError && error.failure.status === 503,
    );
    assert.equal(state.calls.length, 1);
    assert.equal(client.getQueryData(options.queryKey), undefined);
    state.mode = 'malformed';
    await assert.rejects(
      client.infiniteQuery(options),
      (error) => error.failure.code === 'response_invalid',
    );
    assert.equal(state.calls.length, 2);
    state.mode = 'valid';
    await client.infiniteQuery(options);
    assert.equal(state.calls.length, 3);
  } finally {
    client.clear();
  }
});

await test('연결 변경 중 도착한 응답과 캐시 폐기 후의 늦은 응답을 보관하지 않는다', async () => {
  const { client, state } = fixture();
  try {
    const options = ontologySearchOptions(scope, input);
    state.mode = 'pending';
    const started = new Promise((done) => {
      state.started = done;
    });
    const pending = client.infiniteQuery(options);
    const rejected = assert.rejects(
      pending,
      (error) => error.failure.code === 'scope_changed',
    );
    await started;
    state.scope = { ...scope, tenant: 'other' };
    state.release();
    await rejected;
    assert.equal(client.getQueryData(options.queryKey), undefined);
    state.scope = { ...scope };
    const again = new Promise((done) => {
      state.started = done;
    });
    const late = client.infiniteQuery(options);
    const cancelled = assert.rejects(late);
    await again;
    client.clear();
    state.release();
    await cancelled;
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(client.getQueryCache().getAll().length, 0);
  } finally {
    client.clear();
  }
});

await test('관계는 같은 진행 중 요청만 공유하며 다음 조회와 판본/개체/cursor 변경은 서버에서 확인한다', async () => {
  const { client, state } = fixture();
  const neighbors = {
    document: 'a.md',
    entity_id: 'booking',
    expected_state_revision: revision,
    limit: 20,
    cursor: null,
  };
  try {
    const [a, b] = await Promise.all([
      queryOntologyNeighbors(client, scope, neighbors),
      queryOntologyNeighbors(client, scope, neighbors),
    ]);
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
    assert.equal(state.calls.length, 1);
    await queryOntologyNeighbors(client, scope, neighbors);
    assert.equal(state.calls.length, 2);
    for (const change of [
      { expected_state_revision: nextRevision },
      { entity_id: 'other' },
      { cursor: 'next' },
    ])
      await queryOntologyNeighbors(client, scope, { ...neighbors, ...change });
    assert.equal(state.calls.length, 5);
    assert.equal(
      new Set(state.calls.map((request) => JSON.stringify(request.input))).size,
      4,
    );
    state.mode = 'forbidden';
    const denied = await queryOntologyNeighbors(client, scope, neighbors);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.status, 403);
  } finally {
    client.clear();
  }
});
