import type {
  KnowledgeComparisonDetail,
  KnowledgeComparisonLocal,
  KnowledgeComparisonReadRequest,
  KnowledgeComparisonsBridge,
} from '@contracts/knowledgeComparisons.contract';

const referenceId = 'f'.repeat(64);
const excludedId = 'a'.repeat(64);
const latest = 'e'.repeat(32);
const previous = 'd'.repeat(32);
const revision = 'd'.repeat(64);
/** 대조 UI의 결과·범위·인용 표시는 실제 실행과 구분한 격리 자료로 검증합니다. */
function comparison(id: string): KnowledgeComparisonDetail {
  return {
    record: {
      id,
      kind: 'knowledge-comparisons',
      user_id: 'fixture-user',
      tenant: 'fixture',
      data: {
        document: 'sample.md',
        job_id: null,
        session_id: 'fixture-session',
        provider: 'codex',
        basis: {},
        seed_terms: ['열전달'],
      },
      events: [],
    },
    revision,
    status: id === latest ? 'incomplete' : 'complete',
    lookup_count: 5,
    lookup_limit: 5,
    result: {
      candidates: [
        {
          reference_id: referenceId,
          reason:
            id === latest
              ? '공통 실험 조건의 관련 후보'
              : '이전 실행의 관련 후보',
          unconfirmed: ['용어가 같은 개념인지는 확인하지 못함'],
        },
      ],
      excluded: [
        {
          reference_id: excludedId,
          reason: '같은 단어지만 실험 조건이 달라 제외',
          unconfirmed: [],
        },
      ],
      unconfirmed: ['추가 문서 확인 필요'],
      failure: id === latest ? 'comparison_timeout' : null,
      unassessed_reference_ids: ['b'.repeat(64)],
    },
    references: [
      {
        reference_id: referenceId,
        document: 'evidence.md',
        target_ref: {
          snapshot: { evidence: [{ quote: '측정 온도는 20도였다.' }] },
        },
        matched_terms: ['열전달'],
        matched_fields: [
          {
            field: 'claim',
            expression: '열전달 측정값은 조건에 따라 달라진다.',
          },
        ],
        review_status: 'unreviewed',
        policy_status: 'inactive',
      },
      {
        reference_id: excludedId,
        document: 'excluded.md',
        target_ref: { anchor: { quote: '측정 온도는 80도였다.' } },
        matched_terms: ['열전달'],
        matched_fields: [],
        review_status: 'accepted',
        policy_status: 'active',
      },
    ],
    currentness: {
      status: 'needs_recheck',
      changed: ['source_revision'],
      unavailable: [],
    },
    coverage: {
      complete: false,
      truncated: true,
      lookup_limit_reached: true,
      seed_terms_truncated: true,
      semantic_coverage: 'not_guaranteed',
      skipped: [{ lookup_number: 5 }],
    },
  };
}
const local: KnowledgeComparisonLocal = {
  status: 'idle',
  requestId: null,
  resultId: null,
  message: '',
  cleanupWarning: false,
};
export const comparisonChecks = {
  starts: 0,
  stops: 0,
  records: [] as KnowledgeComparisonDetail[],
  seedRecords: [comparison(latest), comparison(previous)],
};
/** 고정 실행 참조를 읽으며 읽기 동작으로 시작 횟수는 바꾸지 않습니다. */
function read(
  request: KnowledgeComparisonReadRequest,
): ReturnType<KnowledgeComparisonsBridge['read']> {
  const value = comparisonChecks.records.find(
    (item: KnowledgeComparisonDetail): boolean =>
      item.record.id === request.comparisonId,
  );
  return Promise.resolve(
    value
      ? {
          ok: true,
          data: { comparison: structuredClone(value), local: { ...local } },
        }
      : { ok: false, error: { code: 'not_found', message: '대조 없음' } },
  );
}
export const comparisonBridge: KnowledgeComparisonsBridge = {
  list: async (): ReturnType<KnowledgeComparisonsBridge['list']> => ({
    ok: true,
    data: {
      items: comparisonChecks.records.map(
        (item: KnowledgeComparisonDetail, index: number) => ({
          id: item.record.id,
          document: item.record.data.document,
          job_id: null,
          created_at:
            index === 0 ? '2026-10-29T13:00:00Z' : '2026-10-28T13:00:00Z',
          status: item.status,
          revision: item.revision,
        }),
      ),
      latestId: comparisonChecks.records[0]?.record.id ?? null,
      nextCursor: null,
      incomplete: true,
    },
  }),
  read,
  restart: async (
    request,
  ): ReturnType<KnowledgeComparisonsBridge['restart']> => {
    comparisonChecks.starts += 1;
    const next = {
      ...comparison('c'.repeat(32)),
      status: 'running' as const,
      result: null,
    };
    comparisonChecks.records.unshift(next);
    const old = await read(request);
    return old.ok
      ? {
          ...old,
          data: { ...old.data, local: { ...local, resultId: next.record.id } },
        }
      : old;
  },
  stopLocal: async (
    request,
  ): ReturnType<KnowledgeComparisonsBridge['stopLocal']> => {
    comparisonChecks.stops += 1;
    const value = comparisonChecks.records.find(
      (item: KnowledgeComparisonDetail): boolean =>
        item.record.id === request.comparisonId,
    );
    if (value) {
      value.status = 'incomplete';
      value.result = {
        candidates: [],
        excluded: [],
        unconfirmed: ['사용자가 중단함'],
        failure: 'comparison_cancelled',
      };
    }
    return read(request);
  },
};
