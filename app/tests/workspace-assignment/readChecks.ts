import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ConnectionService } from '../../src/main/backend/ConnectionService';
import type { ConnectionSnapshot } from '../../src/shared/contracts/connection.contract';

type ReadKind = 'list' | 'content' | 'knowledge' | 'source';
type ReadResult =
  | Awaited<ReturnType<ConnectionService['listDocuments']>>
  | Awaited<ReturnType<ConnectionService['readDocumentContent']>>
  | Awaited<ReturnType<ConnectionService['readDocumentKnowledge']>>
  | Awaited<ReturnType<ConnectionService['readSourcePreview']>>;
type RecordedRequest = { path: string; authenticated: boolean };
type HeldRequest = {
  url: URL;
  signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void;
};
type Access = {
  user_id: string;
  tenant: string;
  profile_id: string;
  domain: string | null;
  viewpoint: string | null;
  policy_revision: string;
  access_revision: string;
};

/** 가짜 HTTP 응답만으로 문서 읽기의 취소·공유 한도·권한 경계를 검사합니다. */
export async function verifyDocumentReads(): Promise<{
  checks: string[];
  requests: RecordedRequest[];
}> {
  const previousFetch = globalThis.fetch;
  const token = 'isolated-document-reader-token-123456789012';
  const revision = 'a'.repeat(64);
  const trace = { trace_id: 'b'.repeat(32) };
  const original = 'Original text.\r\n';
  const source = {
    sourceId: 'c'.repeat(32),
    sourceVersion: 'd'.repeat(32),
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    sizeBytes: Buffer.byteLength(original),
    format: 'txt' as const,
  };
  const requests: RecordedRequest[] = [];
  const checks: string[] = [];
  let hold = false;
  let held: HeldRequest[] = [];
  let failure: { status: number; code: string } | null = null;
  let changedAccess: Partial<Access> = {};
  let malformed = false;
  let wrongDocument = false;
  const kinds: ReadKind[] = ['list', 'content', 'knowledge', 'source'];
  const graph = {
    status: 'current',
    entities: [],
    relations: [],
    attributes: [],
    relation_candidates: [],
  };
  /** 실제 서비스와 같은 원문·지식·원본 응답 봉투를 만듭니다. */
  function response(url: URL): Response {
    if (/\/(auth\/login|access-context)$/u.test(url.pathname)) {
      const membership = {
        display_name: '읽기 공간',
        permissions: ['read'],
        default_profile: 'default',
        profiles: { default: { domain: null, viewpoint: null } },
      };
      return Response.json({
        meta: trace,
        data: {
          token,
          user_id: 'reader',
          display_name: '읽기 사용자',
          default_tenant: 'research',
          policy_revision: revision,
          access_revision: revision,
          memberships: { research: membership, other: membership },
        },
      });
    }
    if (failure)
      return Response.json(
        { error: { code: failure.code, message: 'isolated failure' } },
        { status: failure.status },
      );
    if (malformed) return Response.json({ data: {} });
    const access: Access = {
      user_id: 'reader',
      tenant: url.pathname.split('/')[4] ?? 'research',
      profile_id: 'default',
      domain: null,
      viewpoint: null,
      policy_revision: revision,
      access_revision: revision,
      ...changedAccess,
    };
    const document = wrongDocument
      ? 'another.md'
      : url.searchParams.get('document');
    if (url.pathname.endsWith('/documents'))
      return Response.json({
        meta: trace,
        data: {
          items: [],
          scope: { tenant: access.tenant, kind: 'wiki_documents' },
          catalog_revision: revision,
          next_cursor: null,
          complete: true,
          truncated: false,
          skipped: [],
          scanned: 0,
          requires_refresh: false,
          access,
        },
      });
    if (url.pathname.endsWith('/content'))
      return Response.json({
        meta: trace,
        data: {
          document,
          content: original,
          revision,
          access,
        },
      });
    if (url.pathname.endsWith('/knowledge'))
      return Response.json({
        meta: trace,
        data: {
          document,
          source_revision: revision,
          graph_revision: revision,
          review_revision: null,
          history_revision: revision,
          state_revision: revision,
          status: 'current',
          machine_graph: graph,
          effective_graph: graph,
          claims: [],
          policies: [],
          history: [],
          pending_history: [],
          selection: {},
          needs_review: false,
          access,
        },
      });
    if (url.pathname.endsWith('/file'))
      return new Response(original, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(source.sizeBytes),
          'x-source-sha256': source.sourceSha256,
        },
      });
    return Response.json({
      meta: trace,
      data: {
        source_id: source.sourceId,
        versions: [
          {
            source_version: source.sourceVersion,
            source_sha256: source.sourceSha256,
            size_bytes: source.sizeBytes,
            format: source.format,
          },
        ],
        access,
      },
    });
  }
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      path: url.href,
      authenticated:
        new Headers(init?.headers).get('Authorization') === `Bearer ${token}`,
    });
    if (!hold || /\/(auth\/login|access-context)$/u.test(url.pathname))
      return response(url);
    return new Promise<Response>(
      (resolve: (response: Response) => void): void => {
        held.push({ url, signal: init?.signal, resolve });
      },
    );
  };
  /** 서비스가 공개하는 현재 상태만 사용합니다. */
  function state(service: ConnectionService): ConnectionSnapshot {
    const result = service.getState();
    assert(result.ok);
    assert(!JSON.stringify(result).includes(token));
    return result.data;
  }
  /** 저장소 없는 서비스에 허용 공간을 연결합니다. */
  async function connect(
    service: ConnectionService = new ConnectionService(),
  ): Promise<{ service: ConnectionService; id: string }> {
    const result = await service.authenticate({
      serverUrl: 'http://127.0.0.1:41999/',
      name: '읽기 사용자',
      mode: 'login',
    });
    assert(result.ok && result.data.status === 'connected');
    assert.equal(result.data.selection?.tenant, 'research');
    return { service, id: result.data.connectionId };
  }
  /** 읽기별 공개 요청에 현재 연결 ID를 넣습니다. */
  function read(
    kind: ReadKind,
    service: ConnectionService,
    id: string,
    document = 'example.md',
  ): Promise<ReadResult> {
    if (kind === 'list')
      return service.listDocuments({
        connectionId: id,
        cursor: null,
        limit: 20,
      });
    if (kind === 'content')
      return service.readDocumentContent({ connectionId: id, document });
    if (kind === 'knowledge')
      return service.readDocumentKnowledge({ connectionId: id, document });
    return service.readSourcePreview({ connectionId: id, ...source });
  }
  /** 실패 코드와 연결/선택 유지 여부를 함께 판정합니다. */
  function expectFailure(result: ReadResult, code: string): void {
    assert(!result.ok);
    assert.equal(result.error.code, code);
  }
  /** 의도적으로 AbortSignal을 무시한 늦은 서버 응답도 전달합니다. */
  function releaseAll(): void {
    hold = false;
    for (const request of held) request.resolve(response(request.url));
    held = [];
  }
  try {
    {
      const { service, id } = await connect();
      hold = true;
      const content = read('content', service, id);
      const older = read('list', service, id);
      const latest = read('list', service, id);
      assert.equal(held.length, 3);
      assert.equal(held[0]?.signal?.aborted, false);
      assert.equal(held[1]?.signal?.aborted, true);
      assert.equal(held[2]?.signal?.aborted, false);
      const last = held[2];
      assert(last);
      last.resolve(response(last.url));
      assert((await latest).ok);
      held[1]?.resolve(
        Response.json({ error: { code: 'unauthorized' } }, { status: 401 }),
      );
      expectFailure(await older, 'superseded');
      assert.equal(state(service).status, 'connected');
      releaseAll();
      const body = await content;
      assert(body.ok && 'content' in body.data);
      assert.equal(body.data.content, original);
      checks.push(
        '문서 목록 최신 요청만 유지, 이전 목록 취소·늦은 401 무시, 동시 본문 읽기 보존',
      );
    }
    {
      const { service, id } = await connect();
      hold = true;
      const pending = Array.from(
        { length: 14 },
        (_: unknown, index: number): Promise<ReadResult> =>
          read('content', service, id, `item-${index}.md`),
      );
      pending.push(read('knowledge', service, id), read('source', service, id));
      assert.equal(held.length, 16);
      assert(
        held.every(
          (request: HeldRequest): boolean => request.signal?.aborted === false,
        ),
      );
      const count = requests.length;
      expectFailure(await read('content', service, id), 'read_busy');
      assert.equal(requests.length, count);
      const first = held[0];
      assert(first);
      first.resolve(response(first.url));
      assert((await pending[0])?.ok);
      const nextContent = read('content', service, id);
      held[14]?.resolve(Response.json({ data: {} }));
      expectFailure(await pending[14]!, 'invalid_response');
      const nextKnowledge = read('knowledge', service, id);
      held[15]?.resolve(
        Response.json({ error: { code: 'test_failure' } }, { status: 500 }),
      );
      expectFailure(await pending[15]!, 'test_failure');
      const nextSource = read('source', service, id);
      assert.equal(held.length, 19);
      releaseAll();
      await Promise.all(pending);
      assert((await nextContent).ok);
      assert((await nextKnowledge).ok);
      const preview = await nextSource;
      assert(preview.ok && 'content' in preview.data);
      assert.equal(preview.data.content, original);
      checks.push(
        '본문·지식·원본의 공유 16개 한도, 독립 병렬 읽기, 성공·응답 오류·HTTP 오류 후 자리 회수와 원본 재확인',
      );
    }
    for (const transition of ['disconnect', 'refresh', 'selection'] as const) {
      const { service, id } = await connect();
      hold = true;
      const pending = Array.from(
        { length: 14 },
        (_: unknown, index: number): Promise<ReadResult> =>
          read('content', service, id, `old-${index}.md`),
      );
      pending.push(
        read('knowledge', service, id),
        read('source', service, id),
        read('list', service, id),
      );
      assert.equal(held.length, 17);
      let currentId = id;
      if (transition === 'disconnect') {
        service.disconnect();
        currentId = (await connect(service)).id;
      } else if (transition === 'refresh')
        assert((await service.refreshAccess()).ok);
      else
        assert(
          (
            await service.selectWorkspace({
              connectionId: id,
              tenant: 'other',
              profile: 'default',
            })
          ).ok,
        );
      assert(
        held.every(
          (request: HeldRequest): boolean => request.signal?.aborted === true,
        ),
      );
      hold = false;
      assert((await read('content', service, currentId)).ok);
      for (const request of held)
        request.resolve(
          Response.json({ error: { code: 'unauthorized' } }, { status: 401 }),
        );
      held = [];
      for (const result of await Promise.all(pending))
        expectFailure(result, 'superseded');
      const current = state(service);
      assert(current.status === 'connected');
      assert.equal(
        current.selection?.tenant,
        transition === 'selection' ? 'other' : 'research',
      );
    }
    checks.push(
      '연결 해제/재연결·재확인·공간 전환이 모든 대기 읽기를 취소하고 자리 반환, 늦은 응답의 새 연결 무효화 차단',
    );

    for (const kind of kinds) {
      for (const [status, code] of [
        [401, 'denied'],
        [403, 'denied'],
        [409, 'subject_changed'],
        [409, 'scope_changed'],
        [409, 'access_changed'],
        [500, 'test_failure'],
      ] as const) {
        const { service, id } = await connect();
        failure = { status, code };
        expectFailure(
          await read(kind, service, id),
          status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : code,
        );
        failure = null;
        const current = state(service);
        if (status === 401 || (kind !== 'list' && code === 'subject_changed'))
          assert.equal(current.status, 'disconnected');
        else {
          assert(current.status === 'connected');
          assert.equal(
            current.selection === null,
            status === 403 || (kind !== 'list' && code === 'scope_changed'),
          );
        }
      }
    }
    checks.push(
      '목록의 HTTP 401/403과 내용의 subject/scope 오류 처리 차이 보존, access_changed 단독/일반 실패는 선택 유지',
    );

    for (const kind of kinds) {
      for (const [field, value] of [
        ['user_id', 'someone-else'],
        ['tenant', 'wrong'],
        ['profile_id', 'wrong'],
        ['domain', 'restricted'],
        ['viewpoint', 'restricted'],
        ['access_revision', 'e'.repeat(64)],
      ] as const) {
        const { service, id } = await connect();
        changedAccess = { [field]: value };
        expectFailure(
          await read(kind, service, id),
          field === 'user_id' ? 'subject_changed' : 'scope_changed',
        );
        changedAccess = {};
        const current = state(service);
        if (field === 'user_id') assert.equal(current.status, 'disconnected');
        else {
          assert(current.status === 'connected');
          assert.equal(current.selection, null);
        }
      }
      const { service, id } = await connect();
      changedAccess = { policy_revision: 'f'.repeat(64) };
      assert((await read(kind, service, id)).ok);
      changedAccess = {};
    }
    checks.push(
      '응답 사용자·공간·profile·domain·viewpoint·access revision 불일치 차단, 본인 access가 같으면 전체 policy 변경 허용',
    );

    for (const kind of kinds) {
      const { service, id } = await connect();
      malformed = true;
      expectFailure(
        await read(kind, service, id),
        kind === 'source' ? 'source_mismatch' : 'invalid_response',
      );
      malformed = false;
      assert((await read(kind, service, id)).ok);
      if (kind === 'content' || kind === 'knowledge') {
        wrongDocument = true;
        expectFailure(await read(kind, service, id), 'invalid_response');
        wrongDocument = false;
        assert((await read(kind, service, id)).ok);
      }
    }
    checks.push(
      '응답 형식/문서 이름 불일치는 공개하지 않고 연결·선택·다음 읽기 유지',
    );
    return { checks, requests };
  } finally {
    releaseAll();
    globalThis.fetch = previousFetch;
  }
}
