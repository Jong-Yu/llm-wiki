import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { KnowledgeComparisonService } from '@main/backend/KnowledgeComparisonService';
import type { ComparisonConnection } from '@main/backend/KnowledgeComparisonService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import type { ProcessRecovery } from '@main/backend/processRecovery';
import type {
  RecoveryEntry,
  RecoveryResult,
} from '@contracts/recovery.contract';
import type { KnowledgeComparisonDetail } from '@contracts/knowledgeComparisons.contract';

const temporary = process.env.WIKI_COMPARISON_TEST_ROOT;
const python = process.env.WIKI_COMPARISON_PYTHON;
if (!temporary?.startsWith('/private/tmp/wiki-comparison-check-') || !python)
  throw Error('Isolated fixture required');
const revision = 'a'.repeat(64);
const one = '1'.repeat(32),
  two = '2'.repeat(32),
  three = '3'.repeat(32),
  four = '4'.repeat(32),
  orphan = '5'.repeat(32),
  lost = '6'.repeat(32),
  newResult = '7'.repeat(32);
const scope = {
  userId: 'tester',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: revision,
};
const session = { connectionId: 'fixture', expectedScope: scope };
const access = {
  user_id: 'tester',
  tenant: 'fixture',
  profile_id: 'default',
  policy_revision: revision,
};
let current = true,
  wrongScope = false,
  loss: 'none' | 'before' | 'after' = 'none';
const listeners: Array<() => void> = [];
const records = new Map<string, KnowledgeComparisonDetail>();
const receipts = new Map<string, string>();
const writes: Array<{ id: string; body: unknown }> = [];
/** 서버 저장 상태를 로컬 프로세스와 독립적으로 준비합니다. */
function fixture(
  id: string,
  sessionId: string,
  status: 'running' | 'complete' = 'complete',
): KnowledgeComparisonDetail {
  return {
    record: {
      id,
      kind: 'knowledge-comparisons',
      user_id: 'tester',
      tenant: 'fixture',
      data: {
        document: `${id}.md`,
        job_id: null,
        session_id: sessionId,
        provider: 'codex',
        basis: {},
        seed_terms: ['term'],
      },
      events: [{ kind: 'lookup', operation: 'search', number: 1 }],
    },
    revision,
    status,
    lookup_count: 1,
    lookup_limit: 5,
    result:
      status === 'running'
        ? null
        : { candidates: [], excluded: [], unconfirmed: [], failure: null },
    references: [],
    currentness: { status: 'current', changed: [], unavailable: [] },
  };
}
records.set(one, fixture(one, 'session-one'));
records.set(two, fixture(two, 'session-two'));
records.set(three, fixture(three, 'session-one'));
records.set(four, {
  ...fixture(four, 'claude-session'),
  record: {
    ...fixture(four, 'claude-session').record,
    data: {
      ...fixture(four, 'claude-session').record.data,
      provider: 'claude',
    },
  },
});
records.set(orphan, fixture(orphan, 'orphan', 'running'));
records.set(lost, fixture(lost, 'lost', 'running'));
/** 테스트 HTTP 경계도 실제 JSON 요청·접근 응답을 사용합니다. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (data: unknown, status: number = 200): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        status === 200
          ? {
              data: {
                ...(data as object),
                access: { ...access, user_id: wrongScope ? 'other' : 'tester' },
              },
              meta: { trace_id: one },
            }
          : { error: { code: 'not_found' }, meta: { trace_id: one } },
      ),
    );
  };
  const receiptId = url.pathname.match(
    /personal-requests\/knowledge-comparisons\/([a-f0-9]{32})/,
  )?.[1];
  if (receiptId) {
    const recordId = receipts.get(receiptId);
    if (!recordId) {
      send({}, 404);
      return;
    }
    send({
      request_confirmed: true,
      request_id: receiptId,
      record: records.get(recordId)?.record,
    });
    return;
  }
  const id = url.pathname.match(/knowledge-comparisons\/([a-f0-9]{32})/)?.[1];
  if (!id) {
    send({
      items: [...records.values()].map(
        (item: KnowledgeComparisonDetail): unknown => ({
          id: item.record.id,
          document: item.record.data.document,
          job_id: null,
          created_at: '2026-10-29T00:00:00Z',
          status: item.status,
          revision: item.revision,
        }),
      ),
      latest_id: one,
      next_cursor: null,
      complete: true,
      truncated: false,
      skipped: [],
    });
    return;
  }
  const detail = records.get(id);
  if (!detail) {
    send({}, 404);
    return;
  }
  if (req.method === 'POST') {
    let source = '';
    for await (const part of req) source += String(part);
    const body = z
      .object({
        request_id: z.string(),
        expected_revision: z.string(),
        status: z.literal('incomplete'),
        candidates: z.array(z.never()),
        excluded: z.array(z.never()),
        unconfirmed: z.array(z.string()),
        failure: z.literal('comparison_cancelled'),
      })
      .parse(JSON.parse(source));
    writes.push({ id, body });
    if (loss === 'before') {
      loss = 'none';
      res.destroy();
      return;
    }
    assert.equal(body.expected_revision, detail.revision);
    records.set(id, {
      ...detail,
      status: 'incomplete',
      revision: 'b'.repeat(64),
      record: {
        ...detail.record,
        events: [
          ...detail.record.events,
          { kind: 'result', id: body.request_id },
        ],
      },
      result: body,
    });
    receipts.set(body.request_id, id);
    if (loss === 'after') {
      loss = 'none';
      res.destroy();
      return;
    }
  }
  send(records.get(id));
}
const server = createServer(
  (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((error: unknown): void => {
      console.error(error);
      res.destroy();
    });
  },
);
await new Promise<void>((done: () => void): void => {
  server.listen(0, '127.0.0.1', done);
});
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
    checkedAt: '2026-10-29T00:00:00Z',
  },
  token: 'isolated-fixture-token',
  generation: 1,
  selection: { tenant: 'fixture', profile: 'default' },
};
const connection: ComparisonConnection = {
  analysisContext: async (): Promise<AnalysisContext> => context,
  isAnalysisCurrent: (): boolean => current,
  analysisAccessFailure: (): void => {},
  onScopeChanged: (listener: () => void): void => {
    listeners.push(listener);
  },
};
const journal = new Map<string, RecoveryEntry>();
let saves = 0;
/** 보호 저장소의 판본 충돌도 유지해 중복 쓰기를 허용하지 않습니다. */
function recoveryResult(): RecoveryResult {
  return {
    ok: true,
    data: { entries: [...journal.values()], cleanupWarningCount: 0 },
  };
}
const recovery: ProcessRecovery = {
  capture: async (
    _context,
    kind,
    key,
    payload,
    expectedRevision,
  ): Promise<RecoveryResult> => {
    if ((journal.get(key)?.revision ?? null) !== expectedRevision)
      return {
        ok: false,
        error: { code: 'conflict', message: 'revision conflict' },
      };
    saves += 1;
    journal.set(key, {
      kind,
      key,
      payload,
      revision: saves.toString(16).padStart(64, '0'),
      savedAt: '2026-10-29T00:00:00Z',
    });
    return recoveryResult();
  },
  readContext: async (): Promise<RecoveryResult> => recoveryResult(),
  execute: async (request): Promise<RecoveryResult> => {
    if (request.operation === 'remove') {
      assert.equal(
        request.expectedRevision,
        journal.get(request.key)?.revision,
      );
      journal.delete(request.key);
    }
    return recoveryResult();
  },
};
const project = join(temporary, 'runtime');
await mkdir(join(project, 'tools'), { recursive: true });
await writeFile(
  join(project, 'tools/comparison_cli.py'),
  'import sys\nfor line in sys.stdin:\n if "cancel" in line: break\n',
);
const runtime = {
  projectRoot: project,
  python,
  privateRoot: join(temporary, 'private'),
  ai: { provider: 'codex' as const, cli: 'fixture-cli', model: 'default' },
};
const service = new KnowledgeComparisonService(
  connection,
  recovery,
  async () => runtime,
);
try {
  const list = await service.list({
    ...session,
    document: null,
    jobId: null,
    cursor: null,
  });
  assert.equal(list.ok, true);
  wrongScope = true;
  const denied = await service.read({ ...session, comparisonId: one });
  assert.equal(denied.ok, false);
  wrongScope = false;
  const conflict = await service.restart({
    ...session,
    comparisonId: one,
    expectedRevision: 'f'.repeat(64),
  });
  assert.equal(conflict.ok ? '' : conflict.error.code, 'conflict');
  const mismatch = await service.restart({
    ...session,
    comparisonId: four,
    expectedRevision: revision,
  });
  assert.equal(
    mismatch.ok ? '' : mismatch.error.code,
    'comparison_provider_mismatch',
  );
  assert.equal(saves, 0);
  const results = await Promise.all(
    [one, two].map((comparisonId: string) =>
      service.restart({ ...session, comparisonId, expectedRevision: revision }),
    ),
  );
  for (const result of results)
    assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(service.activities().length, 2);
  const duplicate = await service.restart({
    ...session,
    comparisonId: one,
    expectedRevision: revision,
  });
  assert.equal(duplicate.ok, false);
  const sameSession = await service.restart({
    ...session,
    comparisonId: three,
    expectedRevision: revision,
  });
  assert.equal(sameSession.ok ? '' : sameSession.error.code, 'comparison_busy');
  const pending = journal.get(`compare:${one}`);
  assert.ok(pending);
  const requestId = z
    .object({ requestId: z.string() })
    .parse(JSON.parse(pending.payload)).requestId;
  const next = fixture(newResult, 'session-one', 'running');
  next.record.data.document = records.get(one)!.record.data.document;
  records.set(newResult, next);
  receipts.set(requestId, newResult);
  const read = await service.read({ ...session, comparisonId: one });
  assert.equal(read.ok && read.data.local.resultId, newResult);
  const stopped = await service.stopLocal({ ...session, comparisonId: one });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.deepEqual(
    service.activities().map((item) => item.id),
    [two],
  );
  assert.equal(records.get(newResult)?.status, 'incomplete');
  assert.equal(records.get(one)?.status, 'complete');
  assert.equal(journal.has(`compare:${one}`), false);
  assert.equal(records.get(newResult)?.record.events[0].kind, 'lookup');
  console.log(
    'PASS comparison scope/provider/CAS guards, independent execution, same-session duplicate guard and selected stop with prior result preservation',
  );
  loss = 'after';
  const uncertain = await service.stopLocal({
    ...session,
    comparisonId: orphan,
  });
  assert.equal(uncertain.ok, false);
  assert.ok(journal.has(`compare-cancel:${orphan}`));
  const recovered = await service.read({ ...session, comparisonId: orphan });
  assert.equal(recovered.ok && recovered.data.comparison.status, 'incomplete');
  assert.equal(journal.has(`compare-cancel:${orphan}`), false);
  loss = 'before';
  await service.stopLocal({ ...session, comparisonId: lost });
  assert.ok(journal.has(`compare-cancel:${lost}`));
  const replayed = await service.stopLocal({ ...session, comparisonId: lost });
  assert.equal(replayed.ok, true, JSON.stringify(replayed));
  const lostWrites = writes.filter((item) => item.id === lost);
  assert.equal(lostWrites.length, 2);
  assert.deepEqual(lostWrites[0].body, lostWrites[1].body);
  assert.equal(journal.has(`compare-cancel:${lost}`), false);
  const second = await service.read({ ...session, comparisonId: two });
  assert.equal(second.ok && second.data.local.status, 'running');
  await service.stopLocal({ ...session, comparisonId: two });
  const unresolved = await service.restart({
    ...session,
    comparisonId: two,
    expectedRevision: revision,
  });
  assert.equal(unresolved.ok ? '' : unresolved.error.code, 'outcome_unknown');
  console.log(
    'PASS abandoned comparison cancellation, lost-before/after-save recovery, exact request replay and unresolved-start duplicate protection',
  );
  const third = await service.restart({
    ...session,
    comparisonId: three,
    expectedRevision: revision,
  });
  assert.equal(third.ok, true, JSON.stringify(third));
  current = false;
  listeners.forEach((listener): void => listener());
  assert.equal(service.activities().length, 0);
  await service.shutdown();
  assert.equal(service.activeCount, 0);
  for (const folder of await readdir(runtime.privateRoot)) {
    await assert.rejects(stat(join(runtime.privateRoot, folder, 'auth')));
    await stat(join(runtime.privateRoot, folder, 'work'));
  }
  assert.equal(journal.has(`compare:${three}`), true);
  console.log(
    'PASS scope change stops owned processes, hides old activity, removes tokens and preserves unconfirmed request journals',
  );
} finally {
  await service.shutdown();
  await new Promise<void>((done: () => void): void => {
    server.close((): void => done());
  });
}
