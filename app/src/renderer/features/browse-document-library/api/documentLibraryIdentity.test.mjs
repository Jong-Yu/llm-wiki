import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const result = await build({
  configFile: false,
  logLevel: 'silent',
  root,
  plugins: [react()],
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
      new URL('./documentLibrary.queries.ts', import.meta.url),
    ),
    rolldownOptions: { output: { format: 'es' } },
  },
});
const output = Array.isArray(result) ? result[0].output : result.output;
const chunk = output.find((entry) => entry.type === 'chunk' && entry.isEntry);
assert.ok(chunk);
const {
  queryDocumentLibrary,
  cachedLibraryDocument,
  readLibraryDocumentInfo,
  librarySourceReference,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
);
const access = {
  userId: 'reader',
  tenant: 'workspace',
  profileId: 'default',
  policyRevision: 'p1',
  accessRevision: 'a1',
  domain: null,
  viewpoint: null,
};
const scope = { connectionId: 'connection', ...access };
const item = {
  kind: 'wiki',
  document: 'B07S03-p001.md',
  revision: 'b'.repeat(64),
  sourceStatus: 'unknown',
};
const current = {
  connectionId: scope.connectionId,
  document: item.document,
  revision: item.revision,
  content: '# CO2 Measure',
  metadata: {
    title: '배출량 측정 관계',
    source: { id: 'c'.repeat(32), version: 'd'.repeat(32) },
  },
  access,
  traceId: 'e'.repeat(32),
};
const connected = {
  ok: true,
  data: {
    status: 'connected',
    connectionId: scope.connectionId,
    userId: access.userId,
    policyRevision: access.policyRevision,
    accessRevision: access.accessRevision,
    selection: { tenant: access.tenant, profile: access.profileId },
    workspaces: [
      {
        id: access.tenant,
        permissions: ['read'],
        profiles: [{ id: access.profileId, domain: null, viewpoint: null }],
      },
    ],
  },
};

await test('캐시의 메타정보는 같은 문서·판본·접근 범위일 때만 재사용한다', () => {
  let cached = current;
  const cache = {
    key: (...parts) => parts,
    client: { getQueryData: () => ({ current: cached }) },
  };
  assert.equal(
    cachedLibraryDocument(cache, item, scope).metadata.title,
    '배출량 측정 관계',
  );
  cached = { ...current, revision: 'f'.repeat(64) };
  assert.equal(cachedLibraryDocument(cache, item, scope), null);
  cached = { ...current, access: { ...access, accessRevision: 'a2' } };
  assert.equal(cachedLibraryDocument(cache, item, scope), null);
  cached = { ...current, document: 'another.md' };
  assert.equal(cachedLibraryDocument(cache, item, scope), null);
});

await test('선택한 문서만 읽고 연결된 원본 판본의 제목을 확인하며 알려진 본문은 다시 읽지 않는다', async () => {
  let contentReads = 0;
  let sourceReads = 0;
  globalThis.window = {
    wiki: {
      connection: { getState: async () => connected },
      documents: {
        content: async () => {
          contentReads += 1;
          return { ok: true, data: current };
        },
      },
      sources: {
        versions: async () => {
          sourceReads += 1;
          return {
            ok: true,
            data: {
              connectionId: scope.connectionId,
              access,
              sourceId: current.metadata.source.id,
              versions: [
                { sourceVersion: 'f'.repeat(32), title: '다른 판본 제목' },
                {
                  sourceVersion: current.metadata.source.version,
                  title: '원본 배출량 모델.json',
                },
              ],
            },
          };
        },
      },
    },
  };
  assert.equal(contentReads, 0);
  const info = await readLibraryDocumentInfo(item, scope, null);
  assert.equal(contentReads, 1);
  assert.equal(sourceReads, 1);
  assert.equal(info.metadata.title, current.metadata.title);
  assert.equal(info.source.title, '원본 배출량 모델.json');
  await readLibraryDocumentInfo(item, scope, current);
  assert.equal(contentReads, 1);
  assert.equal(librarySourceReference({}), null);
});

await test('검색 뒤 문서 또는 접근 판본이 바뀌면 잘못된 제목·원본 연결을 채택하지 않는다', async () => {
  globalThis.window.wiki.documents.content = async () => ({
    ok: true,
    data: { ...current, revision: 'f'.repeat(64) },
  });
  await assert.rejects(
    readLibraryDocumentInfo(item, scope, null),
    (error) => error.failure.code === 'catalog_changed',
  );
  globalThis.window.wiki.connection.getState = async () => ({
    ...connected,
    data: { ...connected.data, accessRevision: 'a2' },
  });
  await assert.rejects(
    readLibraryDocumentInfo(item, scope, current),
    (error) => error.failure.code === 'scope_changed',
  );
  delete globalThis.window;
});

await test('묶인 목록과 검색은 서버 계보를 유지하고 현재 Wiki의 지식 상태를 읽는다', async () => {
  const linked = { ...item, metadata: current.metadata };
  const source = {
    kind: 'source',
    sourceId: 'c'.repeat(32),
    sourceVersion: 'd'.repeat(32),
    sourceSha256: 'a'.repeat(64),
    title: '원본 문서',
    sizeBytes: 120,
    format: 'pdf',
    registrationRevision: 'b'.repeat(64),
    linkedDocumentCount: 1,
    linkedDocuments: [linked],
    analysisStatus: 'not_started',
  };
  const calls = [];
  globalThis.window = {
    wiki: {
      connection: { getState: async () => connected },
      documents: {
        list: async (request) => {
          calls.push(request);
          return {
            ok: true,
            data: {
              connectionId: scope.connectionId,
              access,
              scope: { tenant: access.tenant, kind: 'wiki_documents' },
              items: [source],
              nextCursor: 'next',
              truncated: false,
              skipped: [],
              requiresRefresh: false,
            },
          };
        },
      },
      knowledge: {
        read: async (request) => ({
          ok: true,
          data: {
            connectionId: scope.connectionId,
            access,
            document: request.document,
            sourceRevision: item.revision,
            machineGraph: { status: 'ready' },
            effectiveGraph: { relations: [] },
          },
        }),
      },
      workspace: {
        execute: async (request) => {
          calls.push(request);
          return {
            ok: true,
            data: {
              operation: 'search',
              connectionId: scope.connectionId,
              access,
              data: {
                matches: [],
                truncated: false,
                skipped: [],
                scanned: 1,
                sources: {
                  matches: [
                    {
                      source_id: source.sourceId,
                      source_version: source.sourceVersion,
                      source_sha256: source.sourceSha256,
                      title: source.title,
                      size_bytes: 120,
                      format: 'pdf',
                      registration_revision: source.registrationRevision,
                      documents: [
                        {
                          document: item.document,
                          revision: item.revision,
                          metadata: current.metadata,
                          source_status: 'linked',
                          snippet: '찾은 내용',
                        },
                      ],
                    },
                  ],
                  truncated: false,
                },
              },
            },
          };
        },
      },
    },
  };
  const listed = await queryDocumentLibrary({
    query: '',
    cursor: null,
    previousCursors: [],
  });
  assert.equal(listed.status, 'ready');
  assert.equal(calls[0].groupSources, true);
  assert.equal(listed.result.rows.length, 1);
  assert.equal(listed.result.rows[0].extraction, 'ready');
  assert.equal(
    listed.result.rows[0].item.linkedDocuments[0].document,
    item.document,
  );
  assert.equal(listed.result.nextCursor, 'next');
  const searched = await queryDocumentLibrary({
    query: '찾은 내용',
    cursor: null,
    previousCursors: [],
  });
  assert.equal(calls[1].input.group_sources, true);
  assert.equal(searched.status, 'ready');
  assert.equal(searched.result.rows.length, 1);
  assert.deepEqual(
    searched.result.rows[0].item.linkedDocuments[0].metadata.source,
    current.metadata.source,
  );
  assert.equal(searched.result.rows[0].extraction, 'ready');
  delete globalThis.window;
});
