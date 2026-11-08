import { z } from 'zod';
import type {
  ReviewQueueResponse,
  ReviewQueueResponseItem,
} from '../../src/renderer/features/browse-review-queue/model/reviewQueue.schema';

type FixtureMode =
  | 'ok'
  | 'opaque_ids'
  | 'partial'
  | 'empty'
  | 'partial_empty'
  | 'network'
  | 'forbidden'
  | 'catalog_changed'
  | 'invalid'
  | 'wrong_scope';
type FixtureChecks = {
  calls: string[];
  queueCalls: { states: string[]; cursor: string | null; scope: string }[];
  mode: FixtureMode;
  scope: string;
  holdNext: boolean;
  waiting: boolean;
  release: () => void;
};
export const checks: FixtureChecks = {
  calls: [],
  queueCalls: [],
  mode: 'ok',
  scope: 'first',
  holdNext: false,
  waiting: false,
  release: (): void => {},
};
const requestSchema = z.object({
  operation: z.literal('reviewQueue'),
  input: z.object({
    states: z.array(z.enum(['unreviewed', 'defer', 'pending'])),
    cursor: z.string().nullable(),
    coverage: z.literal('tenant'),
    limit: z.literal(20),
    documents: z.array(z.string()).length(0),
    correspondence_ids: z.array(z.string()).length(0),
  }),
});

/** 서버의 네 종류와 정확한 문서·주장 참조를 갖춘 명시적 합성 자료입니다. */
function queueItems(scope: string): ReviewQueueResponseItem[] {
  const ref = (
    reference: string,
  ): Extract<ReviewQueueResponseItem, { kind: 'document_claim' }>['ref'] => ({
    kind: 'document',
    reference,
    source_revision: '1'.repeat(64),
    graph_revision: '2'.repeat(64),
    review_revision: null,
    history_revision: '3'.repeat(64),
    state_revision: '4'.repeat(64),
    status: 'ready',
  });
  const claim = (
    id: string,
    decision: 'unreviewed' | 'defer',
  ): Extract<ReviewQueueResponseItem, { kind: 'document_claim' }>['claim'] => ({
    claim_id: id.repeat(64),
    collection: 'relations',
    value: {
      subject: '제어기',
      predicate: '사용',
      object: '센서',
      evidence: '조건 A에서 센서를 사용한다.',
    },
    reviewed_value: {
      subject: scope === 'first' ? '제어기' : '새 범위 제어기',
      predicate: decision === 'defer' ? '대기' : '사용',
      object: '센서',
      evidence: '조건 A에서 센서를 사용한다.',
    },
    decision,
    review_event_id: null,
    ambiguous: false,
    needs_review: false,
  });
  return [
    {
      key: 'claim-one',
      kind: 'document_claim',
      status: 'unreviewed',
      ref: ref('조건 정의.md'),
      claim: claim('a', 'unreviewed'),
    },
    {
      key: 'claim-two',
      kind: 'document_claim',
      status: 'defer',
      ref: ref('보류 자료.md'),
      claim: claim('b', 'defer'),
    },
    {
      key: 'past-event',
      kind: 'pending_document_event',
      status: 'pending',
      ref: ref('과거 판단.md'),
      event_id: 'c'.repeat(32),
    },
    {
      key: 'stale-graph',
      kind: 'document_graph',
      status: 'pending',
      ref: { ...ref('변경 문서.md'), status: 'stale' },
      graph_status: 'stale',
    },
    {
      key: 'correspondence',
      kind: 'correspondence_judgment',
      status: 'pending',
      ref: {
        kind: 'correspondence',
        reference: 'd'.repeat(32),
        correspondence_revision: '5'.repeat(64),
        state_revision: '6'.repeat(64),
        complete: true,
      },
      judgment: { event_id: '7'.repeat(32) },
    },
  ];
}

/** 모든 fixture 요청도 실제 UI의 states/cursor와 공개 scope를 사용합니다. */
async function queue(value: unknown): Promise<unknown> {
  const request = requestSchema.parse(value);
  const mode = checks.mode;
  const scope = checks.scope;
  checks.calls.push('workspace.reviewQueue');
  checks.queueCalls.push({ ...request.input, scope });
  if (checks.holdNext) {
    checks.holdNext = false;
    checks.waiting = true;
    await new Promise<void>((resolve: () => void): void => {
      checks.release = resolve;
    });
    checks.waiting = false;
  }
  if (mode === 'network' || mode === 'forbidden' || mode === 'catalog_changed')
    return {
      ok: false,
      error: {
        code: mode === 'network' ? 'network_error' : mode,
        message: `${mode} 모의 응답`,
        status:
          mode === 'forbidden' ? 403 : mode === 'catalog_changed' ? 409 : 503,
      },
    };
  if (mode === 'invalid')
    return {
      ok: true,
      data: {
        connectionId: 'review-fixture',
        operation: 'reviewQueue',
        access: access(scope),
        data: {},
      },
    };
  const selected = queueItems(scope)
    .filter((item: ReviewQueueResponseItem): boolean =>
      request.input.states.includes(item.status),
    )
    .map((item: ReviewQueueResponseItem): ReviewQueueResponseItem => {
      if (mode !== 'opaque_ids' || item.kind !== 'document_claim') return item;
      return {
        ...item,
        claim: {
          ...item.claim,
          reviewed_value: {
            subject: 'entity_1',
            predicate: 'uses',
            object: 'f'.repeat(32),
            evidence: {
              quote:
                '제어기는 조건 A에서 센서를 사용하며, 오류가 발생하면 장치를 정지하고 담당자에게 상태를 알린다. 이 문장은 이름 없이 제공된 개체 참조를 대신해 정확히 표시하는 검증용 원문이다.',
              start_line: 2,
              end_line: 3,
            },
          },
        },
      };
    });
  const partial = mode === 'partial' || mode === 'partial_empty';
  const empty = mode === 'empty' || mode === 'partial_empty';
  const next =
    !partial && !empty && selected.length > 3 && request.input.cursor === null
      ? 'page-two'
      : null;
  const items = empty
    ? []
    : partial
      ? selected
      : request.input.cursor
        ? selected.slice(3)
        : selected.slice(0, 3);
  const data: ReviewQueueResponse = {
    kind: 'review_queue',
    scope: {
      tenant: 'fixture',
      coverage: 'tenant_visible_resources',
      states: request.input.states,
      job_visibility: 'current_user_only',
      order: 'resource_reference',
    },
    items,
    resources: selected.map(
      (item: ReviewQueueResponseItem): ReviewQueueResponseItem['ref'] =>
        item.ref,
    ),
    snapshot_revision: '8'.repeat(64),
    consistency: 'per_resource_snapshots',
    total_items: empty ? 0 : selected.length,
    next_cursor: next,
    scope_complete: !partial,
    complete: !partial && next === null,
    truncated: partial,
    skipped: partial
      ? [{ kind: 'document', reference: '누락 문서.md', code: 'capture_limit' }]
      : [],
    requires_refresh: false,
  };
  return {
    ok: true,
    data: {
      connectionId: 'review-fixture',
      operation: 'reviewQueue',
      data,
      access: access(mode === 'wrong_scope' ? 'wrong' : scope),
      traceId: '9'.repeat(32),
    },
  };
}

/** 모의 접근 기준도 요청 시작 당시 값을 보존해 늦은 응답 교차를 재현합니다. */
function access(scope: string): Record<string, string | null> {
  return {
    userId: scope === 'first' ? 'fixture-user' : 'fixture-' + scope,
    tenant: 'fixture',
    profileId: 'default',
    domain: null,
    viewpoint: null,
    policyRevision: 'e'.repeat(64),
    accessRevision: scope === 'first' ? 'f'.repeat(64) : '0'.repeat(64),
  };
}

/** 실제 전송이나 사용자 저장소 없이 같은 공개 읽기 bridge의 모의 응답만 제공합니다. */
export function installBridge(): void {
  const snapshot = (): object => ({
    status: 'connected',
    connectionId: 'review-fixture',
    userId: access(checks.scope).userId,
    policyRevision: 'e'.repeat(64),
    accessRevision: access(checks.scope).accessRevision,
    selection: { tenant: 'fixture', profile: 'default' },
    workspaces: [
      {
        id: 'fixture',
        displayName: '검토 시험 공간 · 모의 자료',
        permissions: ['read'],
        profiles: [{ id: 'default', domain: null, viewpoint: null }],
      },
    ],
  });
  Reflect.set(window, '__reviewChecks', checks);
  Reflect.set(window, 'wiki', {
    connection: {
      getState: async (): Promise<unknown> => ({ ok: true, data: snapshot() }),
    },
    workspace: { execute: queue },
    aiSessions: {
      read: async (): Promise<unknown> => {
        checks.calls.push('aiSessions.read');
        return {
          ok: true,
          data: {
            activities: [],
            usage: {
              provider: 'codex',
              status: 'unavailable',
              accountLabel: null,
              checkedAt: null,
              stale: false,
              windows: [],
              message: '격리 시험은 실제 계정 한도를 조회하지 않습니다.',
            },
          },
        };
      },
    },
    analysis: {
      list: async (): Promise<unknown> => {
        checks.calls.push('analysis.list');
        return {
          ok: true,
          data: {
            items: [
              {
                job_id: 'a'.repeat(32),
                registration: { title: '조건 정의 자료 · 모의 분석' },
                source_ref: {
                  source_id: 'b'.repeat(32),
                  source_version: 'c'.repeat(32),
                },
                targets: [{ document: '조건 정의.md' }],
                result_summary: { status: 'complete' },
                state: 'claimed',
                reported_status: 'complete',
                lease_status: 'none',
              },
              {
                job_id: 'd'.repeat(32),
                registration: { title: '예외 동작 자료 · 모의 분석' },
                source_ref: {
                  source_id: '1'.repeat(32),
                  source_version: '2'.repeat(32),
                },
                targets: [{ document: '예외 동작.md' }],
                result_summary: { status: 'none' },
                state: 'claimed',
                reported_status: 'blocked',
                lease_status: 'none',
              },
            ],
            nextCursor: null,
            complete: true,
            truncated: false,
            skippedCount: 0,
            requiresRefresh: false,
          },
        };
      },
    },
    questionRuns: {
      list: async (): Promise<unknown> => {
        checks.calls.push('questionRuns.list');
        return {
          ok: true,
          data: { items: [], nextCursor: null, incomplete: false },
        };
      },
    },
    knowledgeComparisons: {
      list: async (): Promise<unknown> => {
        checks.calls.push('knowledgeComparisons.list');
        return {
          ok: true,
          data: { items: [], latestId: null, incomplete: false },
        };
      },
    },
  });
}
