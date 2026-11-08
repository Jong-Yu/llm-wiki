import { analysisDetailSchema } from '@contracts/analysis.contract';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import { parseAiSessionsResult } from '@contracts/aiSessions.contract';
import {
  knowledgeComparisonPageResultSchema,
  knowledgeComparisonDetailResultSchema,
} from '@contracts/knowledgeComparisons.contract';

export const visualJobId = 'a'.repeat(32);
export const visualComparisonId = 'f'.repeat(32);
const revision = 'e'.repeat(64);
const actor = {
  user_id: 'fixture-user',
  tenant: 'fixture',
  profile_id: 'default',
  domain: null,
  viewpoint: null,
  policy_revision: revision,
};
/** 실제 화면의 시각 회귀에만 쓰는 합성 연결이며 사용자 서버에 연결하지 않습니다. */
export const visualConnection = {
  ok: true,
  data: {
    status: 'connected',
    connectionId: 'fixture',
    userId: 'fixture-user',
    policyRevision: revision,
    serverUrl: 'http://fixture.invalid',
    displayName: '디자인 검증',
    checkedAt: '2026-10-31T02:00:00Z',
    selection: { tenant: 'fixture', profile: 'default' },
    workspaces: [
      {
        id: 'fixture',
        displayName: '제품 연구',
        permissions: ['read', 'ontology_write', 'ontology_review'],
        defaultProfile: 'default',
        profiles: [{ id: 'default', domain: null, viewpoint: null }],
      },
    ],
  },
};
/** 현재 실행과 저장 영수증을 함께 보여 주는 합성 작업을 실제 계약으로 검증합니다. */
export function visualJob(
  document = '설계/센서-경고-조건.md',
  title = '센서 경고 조건 분석',
  id = visualJobId,
  active = false,
): AnalysisDetail {
  const receipt = {
    request_id: '1'.repeat(32),
    state: 'complete',
    saved: true,
    receipt: {
      actor,
      document,
      stage: 'prepare_wiki',
      source_revision: revision,
      graph_revision: null,
      state_revision: null,
      bundle_id: '2'.repeat(32),
      bundle_revision: revision,
      review_status: 'unreviewed',
    },
    validation_report: null,
    current_output: { status: 'current' },
    cleanup_failures: [],
  };
  return analysisDetailSchema.parse({
    job: {
      actor,
      job_id: id,
      tenant: 'fixture',
      user_id: 'fixture-user',
      request_id: 'd'.repeat(32),
      created_at: '2026-10-31T01:42:00Z',
      registration: { mode: 'preserve', title, conversion_ref: null },
      source_ref: {
        source_id: 'b'.repeat(32),
        source_version: 'c'.repeat(32),
        source_sha256: revision,
        size_bytes: 3400,
        registration_revision: revision,
      },
      targets: [{ document, source_revision: null, state_revision: null }],
      outputs: ['wiki'],
      state: 'claimed',
      run_id: '3'.repeat(32),
      reported_status: active ? 'analyzing' : null,
      job_revision: revision,
      events: [],
      lease_status: active ? 'active' : 'none',
      lease_expires_at: null,
      basis_status: 'current',
      blockers: [],
      input_readiness: 'ready',
      result_summary: {
        status: active ? 'partial' : 'complete',
        saved_count: 1,
        required_count: active ? 2 : 1,
        results: [
          {
            request_id: receipt.request_id,
            stage: 'prepare_wiki',
            document,
            run_id: '3'.repeat(32),
            state: 'complete',
            saved: true,
          },
        ],
      },
    },
    local: {
      status: active ? 'running' : 'completed',
      message: active
        ? '원문을 바탕으로 개체와 관계를 정리하고 있습니다.'
        : '문서 저장을 확인했습니다.',
    },
    receipts: [receipt],
    receiptErrors: [],
  });
}
/** 사용량·진행 상태도 앱과 동일한 공개 응답 검증을 통과시킵니다. */
export const visualActivity = parseAiSessionsResult({
  ok: true,
  data: {
    activities: [
      {
        kind: 'analysis',
        id: visualJobId,
        connectionId: 'fixture',
        status: 'running',
        startedAt: '2026-10-31T01:52:00Z',
        document: '설계/센서-경고-조건.md',
      },
    ],
    usage: {
      provider: 'codex',
      status: 'available',
      accountLabel: '디자인 검증',
      checkedAt: '2026-10-31T02:00:00Z',
      stale: false,
      windows: [
        {
          name: '5시간',
          usedPercent: 28,
          remainingPercent: 72,
          windowMinutes: 300,
          resetsAt: '2026-10-31T06:00:00Z',
        },
      ],
      message: null,
    },
  },
});
/** 저장된 대조의 후보와 인용을 실제 응답 스키마에 맞춰 제공합니다. */
export const visualComparisonList = knowledgeComparisonPageResultSchema.parse({
  ok: true,
  data: {
    items: [
      {
        id: visualComparisonId,
        document: '설계/센서-경고-조건.md',
        job_id: visualJobId,
        created_at: '2026-10-31T01:48:00Z',
        status: 'complete',
        revision,
      },
    ],
    latestId: visualComparisonId,
    incomplete: false,
    nextCursor: null,
  },
});
export const visualComparisonDetail =
  knowledgeComparisonDetailResultSchema.parse({
    ok: true,
    data: {
      comparison: {
        record: {
          id: visualComparisonId,
          kind: 'knowledge-comparisons',
          user_id: 'fixture-user',
          tenant: 'fixture',
          data: {
            document: '설계/센서-경고-조건.md',
            job_id: visualJobId,
            session_id: 'design-review',
            provider: 'codex',
            basis: {},
            seed_terms: ['센서', '경고', '작동 조건'],
          },
          events: [],
        },
        revision,
        status: 'complete',
        lookup_count: 3,
        lookup_limit: 5,
        coverage: {
          complete: true,
          truncated: false,
          lookup_limit_reached: false,
          seed_terms_truncated: false,
          semantic_coverage: 'not_guaranteed',
          skipped: [],
        },
        result: {
          candidates: [
            {
              reference_id: '7'.repeat(64),
              reason:
                '경고를 보내는 조건과 센서의 동작 범위를 함께 설명합니다.',
              unconfirmed: [],
            },
            {
              reference_id: '8'.repeat(64),
              reason: '상태 전환 시점의 경고 처리 방식을 비교할 수 있습니다.',
              unconfirmed: [],
            },
          ],
          excluded: [],
          unconfirmed: [],
          failure: null,
        },
        references: [
          {
            reference_id: '7'.repeat(64),
            target_ref: {
              anchor: {
                quote: '온도가 설정 범위를 벗어나면 경고 신호를 보낸다.',
              },
            },
            document: '설계/온도-센서-인터페이스.md',
            matched_terms: ['센서', '경고'],
            matched_fields: [],
            review_status: 'unreviewed',
            policy_status: 'not_reviewed',
          },
          {
            reference_id: '8'.repeat(64),
            target_ref: {
              anchor: {
                quote: '운전 모드가 전환되는 동안 기존 경고 상태를 유지한다.',
              },
            },
            document: '설계/운전-모드-전환.md',
            matched_terms: ['경고', '작동 조건'],
            matched_fields: [],
            review_status: 'accepted',
            policy_status: 'not_reviewed',
          },
        ],
        currentness: { status: 'current', changed: [], unavailable: [] },
      },
      local: {
        status: 'exited',
        message: '',
        requestId: null,
        resultId: visualComparisonId,
        cleanupWarning: false,
      },
    },
  });
