import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
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
    ssr: fileURLToPath(new URL('./bundle.mjs', import.meta.url)),
    rolldownOptions: { output: { format: 'es' } },
  },
});
const output = Array.isArray(result) ? result[0].output : result.output;
const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
assert(chunk);
const {
  ReadQueryCache,
  ReadQueryError,
  documentContentOptions,
  queryCurrentContent,
  queryDocumentHistory,
  queryHistoricalContent,
  saveDocumentContent,
  timeoutManager,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
);
// Node 검사의 회수 타이머는 브라우저처럼 검사 프로세스를 유지하지 않습니다.
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
  clearTimeout,
  setInterval: (callback, delay) => {
    const timer = setInterval(callback, delay);
    timer.unref();
    return timer;
  },
  clearInterval,
});
const revision = 'a'.repeat(64),
  nextRevision = 'b'.repeat(64);
const scope = {
  userId: 'reader',
  tenant: 'space-a',
  profileId: 'default',
  accessRevision: revision,
  policyRevision: revision,
};
function fixture(identity = 'reader/space-a/default/access-a') {
  const cache = new ReadQueryCache(identity);
  cache.client.setDefaultOptions({
    queries: { ...cache.client.getDefaultOptions().queries, gcTime: 50 },
  });
  const state = {
    count: 0,
    writes: [],
    revision,
    mode: 'ok',
    release: null,
    started: null,
    changed: false,
    notifications: 0,
  };
  globalThis.window = {
    dispatchEvent: () => {
      state.notifications++;
    },
    wiki: {
      connection: {
        getState: async () => ({
          ok: true,
          data: {
            status: 'connected',
            connectionId: 'connection-a',
            ...scope,
            userId: state.changed ? 'other' : scope.userId,
            selection: { tenant: scope.tenant, profile: scope.profileId },
            workspaces: [{ id: scope.tenant, permissions: ['read', 'write'] }],
          },
        }),
      },
      documents: {
        content: async (request) => {
          state.count++;
          if (state.mode === 'pending')
            await new Promise((done) => {
              state.release = done;
              state.started?.();
            });
          if (state.mode === 'forbidden')
            return {
              ok: false,
              error: {
                code: 'forbidden',
                status: 403,
                message: '합성 권한 회수',
              },
            };
          if (state.mode === 'network')
            return {
              ok: false,
              error: { code: 'network_failed', message: '합성 네트워크 실패' },
            };
          return {
            ok: true,
            data: {
              connectionId: 'connection-a',
              document: request.document,
              content: '원문',
              body: '원문',
              revision: state.revision,
              access: scope,
              metadata: { title: '문서', tags: ['보존'] },
            },
          };
        },
      },
      workspace: {
        execute: async (request) => {
          if (
            request.operation === 'documentVersions' ||
            request.operation === 'documentVersion'
          ) {
            state.versions ??= [];
            state.versions.push(request);
            const item = {
              history_id: request.input.history_id ?? 'old-1',
              revision,
              size_bytes: 6,
              archived_at: null,
              author: { user_id: 'reader' },
              reason: null,
            };
            return {
              ok: true,
              data: {
                operation: request.operation,
                access: scope,
                data:
                  request.operation === 'documentVersion'
                    ? {
                        ...item,
                        document: request.input.document,
                        content: '과거 본문',
                      }
                    : {
                        document: request.input.document,
                        current: { revision: state.revision },
                        items: [item],
                        catalog_revision: state.revision,
                        next_cursor: null,
                        complete: false,
                        truncated: true,
                        skipped: [
                          { history_id: 'broken', code: 'unavailable' },
                        ],
                        requires_refresh: false,
                      },
              },
            };
          }
          state.writes.push(request);
          return {
            ok: false,
            error: {
              code: 'conflict',
              status: 409,
              message: '현재 판본과 다릅니다.',
            },
          };
        },
      },
    },
  };
  return { cache, state };
}

await test('읽기 결과는 동일 세션/조건에서 공유하고 자원·경로·접근 세대는 분리한다', async () => {
  const { cache, state } = fixture();
  const other = new ReadQueryCache('reader/space-b/default/access-b');
  try {
    const options = documentContentOptions(cache, 'a.md');
    const [a, b] = await Promise.all([
      cache.client.query(options),
      cache.client.query(options),
    ]);
    assert.deepEqual(a, b);
    assert.equal(state.count, 1);
    await cache.client.query(options);
    assert.equal(state.count, 1);
    assert.notDeepEqual(
      options.queryKey,
      documentContentOptions(cache, 'b.md').queryKey,
    );
    assert.notDeepEqual(
      options.queryKey,
      documentContentOptions(other, 'a.md').queryKey,
    );
    assert.notDeepEqual(
      cache.key('document-library'),
      cache.key('session-catalog'),
    );
    cache.clear();
    assert.notDeepEqual(
      options.queryKey,
      documentContentOptions(cache, 'a.md').queryKey,
    );
    await cache.client.query(documentContentOptions(cache, 'a.md'));
    assert.equal(state.count, 2);
  } finally {
    cache.client.clear();
    other.client.clear();
  }
});

await test('명시 최신 확인은 15초 안에도 다시 읽고 동시 읽기만 공유하며 편집용 복사본은 분리한다', async () => {
  const { cache, state } = fixture();
  try {
    const first = await queryCurrentContent(cache, 'a.md');
    assert(first.ok);
    state.revision = nextRevision;
    const [a, b] = await Promise.all([
      queryCurrentContent(cache, 'a.md'),
      queryCurrentContent(cache, 'a.md'),
    ]);
    assert(a.ok && b.ok);
    assert.equal(state.count, 2);
    assert.equal(a.data.current.revision, nextRevision);
    a.data.current.metadata.tags.push('초안 전용');
    assert.deepEqual(b.data.current.metadata.tags, ['보존']);
    assert.deepEqual(
      cache.client.getQueryData(documentContentOptions(cache, 'a.md').queryKey)
        .current.metadata.tags,
      ['보존'],
    );
    assert.equal(first.data.current.revision, revision);
  } finally {
    cache.client.clear();
  }
});

await test('일반 갱신 실패는 성공한 자료를 유지하며 자동 재시도하지 않는다', async () => {
  const { cache, state } = fixture();
  try {
    const options = documentContentOptions(cache, 'a.md');
    await cache.client.query(options);
    state.mode = 'network';
    await assert.rejects(
      cache.client.query({ ...options, staleTime: 0 }),
      (error) => error.failure.code === 'network_failed',
    );
    assert.equal(state.count, 2);
    assert.equal(cache.getSnapshot().failure, null);
    assert.equal(
      cache.client.getQueryData(options.queryKey).current.revision,
      revision,
    );
  } finally {
    cache.client.clear();
  }
});

await test('403은 문서·목록·이력 캐시를 함께 폐기하고 명시 재조회까지 차단한다', async () => {
  const { cache, state } = fixture();
  try {
    cache.client.setQueryData(cache.key('document-library'), {
      title: '기존 목록',
    });
    cache.client.setQueryData(cache.key('session-catalog'), {
      title: '기존 이력',
    });
    state.mode = 'forbidden';
    const denied = await queryCurrentContent(cache, 'a.md');
    assert(!denied.ok);
    assert.equal(cache.getSnapshot().failure.status, 403);
    assert.equal(cache.client.getQueryCache().getAll().length, 0);
    await queryCurrentContent(cache, 'a.md');
    assert.equal(state.count, 1);
    state.mode = 'ok';
    cache.clear();
    assert((await queryCurrentContent(cache, 'a.md')).ok);
  } finally {
    cache.client.clear();
  }
});

await test('연결 변경/캐시 폐기 뒤의 늦은 본문은 새 세대에 등록하지 않는다', async () => {
  const { cache, state } = fixture();
  try {
    state.mode = 'pending';
    const started = new Promise((done) => {
      state.started = done;
    });
    const pending = queryCurrentContent(cache, 'a.md');
    await started;
    cache.clear();
    state.release();
    const result = await pending;
    assert(!result.ok);
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(cache.client.getQueryCache().getAll().length, 0);
  } finally {
    cache.client.clear();
  }
});

await test('갱신한 캐시가 있어도 기존 초안의 원래 revision으로 한 번만 저장한다', async () => {
  const { cache, state } = fixture();
  try {
    const first = await queryCurrentContent(cache, 'a.md');
    assert(first.ok);
    const draft = first.data.current;
    state.revision = nextRevision;
    await queryCurrentContent(cache, 'a.md');
    const result = await saveDocumentContent(draft, '수정안');
    assert(!result.ok);
    assert.equal(result.error.code, 'conflict');
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].input.expected_revision, revision);
    assert.equal(state.writes[0].input.content, '수정안');
    assert.equal(state.notifications, 1);
  } finally {
    cache.client.clear();
  }
});

await test('StrictMode의 빠른 재연결은 캐시를 지우지 않고 실제 종료만 정리한다', async () => {
  const { cache } = fixture();
  try {
    cache.client.setQueryData(cache.key('document-library'), 'retained');
    const first = cache.beginUse();
    cache.endUse(first);
    const second = cache.beginUse();
    await Promise.resolve();
    assert.equal(
      cache.client.getQueryData(cache.key('document-library')),
      'retained',
    );
    cache.endUse(second);
    await Promise.resolve();
    assert.equal(cache.client.getQueryCache().getAll().length, 0);
  } finally {
    cache.client.clear();
  }
});

await test('과거 파일은 판본/이력 ID별로 재사용하고 현재 이력 목록은 매번 확인한다', async () => {
  const { cache, state } = fixture();
  try {
    const source = await queryCurrentContent(cache, 'a.md');
    assert(source.ok);
    const current = source.data.current;
    const first = await queryHistoricalContent(cache, current, 'old-1');
    assert(first.ok);
    first.data.author.user_id = '초안 전용';
    const again = await queryHistoricalContent(cache, current, 'old-1');
    assert(again.ok);
    assert.equal(again.data.author.user_id, 'reader');
    assert.equal(state.versions.length, 1);
    await queryHistoricalContent(cache, current, 'old-2');
    await queryHistoricalContent(
      cache,
      { ...current, revision: nextRevision },
      'old-1',
    );
    assert.equal(state.versions.length, 3);
    const page = await queryDocumentHistory(cache, current, null);
    assert(page.ok);
    assert.equal(page.data.truncated, true);
    assert.equal(page.data.skipped.length, 1);
    await queryDocumentHistory(cache, current, null);
    assert.equal(state.versions.length, 5);
    state.revision = nextRevision;
    const changed = await queryDocumentHistory(cache, current, null);
    assert(!changed.ok);
    assert.equal(changed.error.code, 'catalog_changed');
  } finally {
    cache.client.clear();
  }
});
