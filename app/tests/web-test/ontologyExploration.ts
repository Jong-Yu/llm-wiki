import assert from 'node:assert/strict';
import { ConnectionService } from '../../src/main/backend/ConnectionService';
import { WorkspaceApiService } from '../../src/main/backend/WorkspaceApiService';
import {
  ontologyMapEdgeSchema,
  ontologyNeighborPageSchema,
  ontologySearchPageSchema,
  ontologyNeighborsInputSchema,
  ontologyGlossaryCardSchema,
  ontologyGlossaryInputSchema,
} from '../../src/shared/contracts/ontologyExploration.contract';
import {
  parseWorkspaceRequest,
  parseWorkspaceResult,
} from '../../src/shared/contracts/workspace.contract';
import { parseDocumentListResult } from '../../src/shared/contracts/documents.contract';

type Post = (channel: string, args: unknown[]) => Promise<unknown>;
const revision = 'a'.repeat(64);
const access = {
  user_id: 'map-reader',
  tenant: 'map-fixture',
  profile_id: 'default',
  domain: null,
  viewpoint: null,
  policy_revision: revision,
  access_revision: 'b'.repeat(64),
};
const page = {
  items: [],
  index_revision: revision,
  next_cursor: null,
  total: 0,
  coverage: {
    complete: false,
    skipped: [{ document: 'broken.md', code: 'unavailable' }],
    truncated: false,
  },
  access,
};
const glossary = {
  document: {
    document: 'booking.md',
    kind: 'document',
    reference: 'booking.md',
    source_revision: revision,
    graph_revision: revision,
    review_revision: null,
    history_revision: revision,
    state_revision: revision,
    status: 'ready',
  },
  entity: {
    id: 'booking',
    label: '예약',
    type: 'service',
    context: { domain: '예약 업무', viewpoints: ['business'] },
    identifiers: [],
  },
  source_passage: {
    quote: '예약 업무의 예약 서비스.',
    start_line: 3,
    end_line: 3,
    source_revision: revision,
  },
  source_passage_status: 'available',
  attributes: [],
  relations: [],
  totals: { attributes: 0, relations: 0 },
  coverage: { complete: true, truncated: false, skipped: [] },
  access,
};
const anchorId = 'c'.repeat(64);
const neighbors = {
  index_revision: revision,
  next_cursor: null,
  total: 1,
  coverage: { complete: true, truncated: false, skipped: [] },
  access,
  document: glossary.document,
  entity_id: 'booking',
  concepts: [
    {
      document: 'booking.md',
      entity_id: 'booking',
      name: '예약',
      type: 'service',
      attribute_count: 0,
      ref: glossary.document,
    },
  ],
  anchors: [
    {
      document: 'booking.md',
      anchor_id: anchorId,
      source_revision: revision,
      start_line: 3,
      end_line: 3,
      occurrence: 0,
      ref: glossary.document,
    },
  ],
  edges: [
    {
      key: 'e'.repeat(64),
      document: 'booking.md',
      subject: { document: 'booking.md', entity_id: 'booking' },
      object: { document: 'booking.md', anchor_id: anchorId },
      label: 'has_source_metadata',
      origin: 'machine',
      collection: 'relations',
      original_collection: 'relations',
      claim_id: revision,
      collection_index: 0,
      polarity: null,
      modality: null,
      conditional: false,
      ref: glossary.document,
    },
  ],
};

/** 스키마 실패·접근 변경·늦은 응답을 실제 main 서비스의 공개 메서드에서 거부합니다. */
export async function verifyOntologyTransportBoundaries(): Promise<number> {
  let checks = 0;
  const originalFetch = globalThis.fetch;
  let mode = 'valid';
  let requests = 0;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const received: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (
      url.pathname.endsWith('/ontology/search') ||
      url.pathname.endsWith('/ontology/glossary') ||
      url.pathname.endsWith('/ontology/neighbors')
    ) {
      requests++;
      received.push({ path: url.pathname, body });
      if (mode === 'late') {
        await new Promise<void>((resolve): void => {
          release = resolve;
          started?.();
        });
      }
      return Response.json({
        data: {
          ...(url.pathname.endsWith('/ontology/glossary')
            ? glossary
            : url.pathname.endsWith('/ontology/neighbors')
              ? neighbors
              : page),
          ...(mode === 'wrong-anchor-revision'
            ? {
                anchors: [
                  {
                    ...neighbors.anchors[0],
                    source_revision: 'f'.repeat(64),
                  },
                ],
              }
            : {}),
          ...(mode === 'malformed' ? { effective_graph: {} } : {}),
          ...(mode === 'wrong-entity'
            ? { entity: { ...glossary.entity, id: 'other' } }
            : {}),
          ...(mode === 'wrong-state'
            ? {
                document: {
                  ...glossary.document,
                  state_revision: 'e'.repeat(64),
                },
              }
            : {}),
          access: {
            ...access,
            ...(mode === 'wrong-user' ? { user_id: 'other' } : {}),
            ...(mode === 'wrong-access'
              ? { access_revision: 'c'.repeat(64) }
              : {}),
          },
        },
        meta: { trace_id: 'd'.repeat(32) },
      });
    }
    return Response.json({
      data: {
        token: 'isolated-map-test-token-1234567890',
        user_id: access.user_id,
        display_name: '격리 지도 검증',
        default_tenant: access.tenant,
        policy_revision: access.policy_revision,
        access_revision: access.access_revision,
        memberships: {
          [access.tenant]: {
            permissions: ['read'],
            default_profile: 'default',
            profiles: { default: { domain: null, viewpoint: null } },
          },
        },
      },
      meta: { trace_id: 'd'.repeat(32) },
    });
  };
  try {
    assert.equal(ontologySearchPageSchema.parse(page).coverage.complete, false);
    assert(
      !ontologySearchPageSchema.safeParse({ ...page, evidence: 'full text' })
        .success,
    );
    assert(
      !ontologyNeighborsInputSchema.safeParse({
        document: '../a.md',
        entity_id: 'a',
        expected_state_revision: revision,
      }).success,
    );
    assert(!ontologyMapEdgeSchema.safeParse({ key: 'missing-ref' }).success);
    assert.throws((): void => {
      parseWorkspaceRequest({
        connectionId: 'id',
        operation: 'ontologySearch',
        input: { actor: 'forged' },
      });
    });
    checks++;
    const connection = new ConnectionService();
    const authenticated = await connection.authenticate({
      serverUrl: 'http://127.0.0.1:41999/',
      name: '격리 지도 검증',
      mode: 'login',
    });
    assert(authenticated.ok && authenticated.data.status === 'connected');
    const request = parseWorkspaceRequest({
      connectionId: authenticated.data.connectionId,
      expectedScope: {
        userId: access.user_id,
        tenant: access.tenant,
        profileId: 'default',
        policyRevision: 'f'.repeat(64),
        accessRevision: access.access_revision,
      },
      operation: 'ontologySearch',
      input: { text: '', kind: 'concept', limit: 1 },
    });
    const api = new WorkspaceApiService(connection);
    const valid = await api.execute(request);
    assert(valid.ok);
    assert.deepEqual(
      ontologySearchPageSchema.parse(valid.data.data).coverage,
      page.coverage,
    );
    assert.deepEqual(received[0], {
      path: '/api/v1/tenants/map-fixture/ontology/search',
      body: { text: '', kind: 'concept', limit: 1, profile: 'default' },
    });
    checks++;
    const neighborRequest = parseWorkspaceRequest({
      ...request,
      operation: 'ontologyNeighbors',
      input: {
        document: 'booking.md',
        entity_id: 'booking',
        expected_state_revision: revision,
        limit: 20,
      },
    });
    const neighborResult = await api.execute(neighborRequest);
    assert(neighborResult.ok);
    assert.deepEqual(
      ontologyNeighborPageSchema.parse(neighborResult.data.data),
      neighbors,
    );
    assert.deepEqual(received.at(-1), {
      path: '/api/v1/tenants/map-fixture/ontology/neighbors',
      body: { ...neighborRequest.input, profile: 'default' },
    });
    checks++;
    for (const invalidAnchor of [
      { ...neighbors.anchors[0], quote: 'must not travel with a map summary' },
      { ...neighbors.anchors[0], document: 'other.md' },
      { ...neighbors.anchors[0], end_line: 2 },
      { ...neighbors.anchors[0], source_revision: 'f'.repeat(64) },
    ])
      assert(
        !ontologyNeighborPageSchema.safeParse({
          ...neighbors,
          anchors: [invalidAnchor],
        }).success,
      );
    assert(
      !ontologyMapEdgeSchema.safeParse({
        ...neighbors.edges[0],
        object: { ...neighbors.edges[0].object, entity_id: 'booking' },
      }).success,
    );
    mode = 'wrong-anchor-revision';
    const mismatchedAnchor = await api.execute(neighborRequest);
    assert(!mismatchedAnchor.ok);
    mode = 'valid';
    checks++;
    const glossaryRequest = parseWorkspaceRequest({
      ...request,
      operation: 'ontologyGlossary',
      input: {
        document: 'booking.md',
        entity_id: 'booking',
        expected_state_revision: revision,
        limit: 10,
      },
    });
    assert(
      !ontologyGlossaryInputSchema.safeParse({
        ...glossaryRequest.input,
        actor: 'forged',
      }).success,
    );
    assert(
      !ontologyGlossaryCardSchema.safeParse({ ...glossary, history: [] })
        .success,
    );
    const glossaryResult = await api.execute(glossaryRequest);
    assert(glossaryResult.ok);
    assert.deepEqual(
      ontologyGlossaryCardSchema.parse(glossaryResult.data.data),
      glossary,
    );
    assert.deepEqual(received.at(-1), {
      path: '/api/v1/tenants/map-fixture/ontology/glossary',
      body: { ...glossaryRequest.input, profile: 'default' },
    });
    for (const invalid of ['wrong-entity', 'wrong-state']) {
      mode = invalid;
      const mismatched = await api.execute(glossaryRequest);
      assert(!mismatched.ok && mismatched.error.code === 'response_invalid');
      checks++;
    }
    mode = 'malformed';
    const excessive = await api.execute(glossaryRequest);
    assert(!excessive.ok && excessive.error.code === 'read_failed');
    mode = 'valid';
    checks++;
    const countBefore = requests;
    const wrongScope = await api.execute({
      ...request,
      expectedScope: {
        userId: 'other',
        tenant: access.tenant,
        profileId: 'default',
        policyRevision: revision,
      },
    });
    assert(!wrongScope.ok && wrongScope.error.code === 'scope_changed');
    assert.equal(requests, countBefore);
    checks++;
    mode = 'malformed';
    const malformed = await api.execute(request);
    assert(!malformed.ok && malformed.error.code === 'read_failed');
    checks++;
    mode = 'wrong-user';
    const wrongUser = await api.execute(request);
    assert(!wrongUser.ok && wrongUser.error.code === 'scope_changed');
    checks++;
    const changedAccess = new ConnectionService();
    const accessLogin = await changedAccess.authenticate({
      serverUrl: 'http://127.0.0.1:41999/',
      name: '격리 지도 검증',
      mode: 'login',
    });
    assert(accessLogin.ok && accessLogin.data.status === 'connected');
    mode = 'wrong-access';
    const wrongAccess = await new WorkspaceApiService(changedAccess).execute({
      ...request,
      connectionId: accessLogin.data.connectionId,
    });
    assert(!wrongAccess.ok && wrongAccess.error.code === 'scope_changed');
    checks++;
    // 응답에서 범위가 바뀌면 연결이 무효화되므로 독립 서비스로 후속 범위를 검증합니다.
    const newer = new ConnectionService();
    const loggedIn = await newer.authenticate({
      serverUrl: 'http://127.0.0.1:41999/',
      name: '격리 지도 검증',
      mode: 'login',
    });
    assert(loggedIn.ok && loggedIn.data.status === 'connected');
    const newerApi = new WorkspaceApiService(newer);
    const newerRequest = {
      ...request,
      connectionId: loggedIn.data.connectionId,
    };
    mode = 'late';
    const pendingStarted = new Promise<void>((resolve): void => {
      started = resolve;
    });
    const pending = newerApi.execute(newerRequest);
    await pendingStarted;
    newer.disconnect();
    release?.();
    const late = await pending;
    assert(!late.ok && late.error.code === 'scope_changed');
    checks++;
  } finally {
    globalThis.fetch = originalFetch;
  }
  return checks;
}

/** 웹 bridge→공통 main→격리 HTTP에서 새 검색 페이지와 stale scope 거부를 확인합니다. */
export async function verifyOntologyWebTransport(
  post: Post,
  connectionId: string,
): Promise<number> {
  const list = parseDocumentListResult(
    await post('documents:list', [{ connectionId, cursor: null, limit: 20 }]),
  );
  assert(list.ok);
  const { userId, tenant, profileId, policyRevision, accessRevision } =
    list.data.access;
  const expectedScope = {
    userId,
    tenant,
    profileId,
    policyRevision,
    accessRevision,
  };
  for (const suffix of ['a', 'b']) {
    const saved = parseWorkspaceResult(
      await post('workspace:execute', [
        {
          connectionId,
          expectedScope,
          operation: 'saveDocument',
          input: {
            document: `ontology-transport-${suffix}.md`,
            content: '전송 검증\n',
            expected_revision: null,
          },
        },
      ]),
    );
    assert(saved.ok);
  }
  const search = async (
    cursor: string | null,
  ): Promise<ReturnType<typeof parseWorkspaceResult>> =>
    parseWorkspaceResult(
      await post('workspace:execute', [
        {
          connectionId,
          expectedScope,
          operation: 'ontologySearch',
          input: {
            text: 'ontology-transport',
            kind: 'document',
            limit: 1,
            cursor,
          },
        },
      ]),
    );
  const first = await search(null);
  assert(first.ok);
  const firstPage = ontologySearchPageSchema.parse(first.data.data);
  assert.equal(firstPage.total, 2);
  assert(firstPage.next_cursor);
  const second = await search(firstPage.next_cursor);
  assert(second.ok);
  const secondPage = ontologySearchPageSchema.parse(second.data.data);
  assert.equal(secondPage.next_cursor, null);
  assert.notDeepEqual(firstPage.items, secondPage.items);
  const wrongScope = parseWorkspaceResult(
    await post('workspace:execute', [
      {
        connectionId,
        expectedScope: { ...expectedScope, userId: 'other' },
        operation: 'ontologySearch',
        input: {},
      },
    ]),
  );
  assert(!wrongScope.ok && wrongScope.error.code === 'scope_changed');
  return 4;
}
