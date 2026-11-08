import { proposalSchema } from '../../src/renderer/features/review-analysis-proposals/model/analysisProposal.schema';
import type { ProposalRecord } from '../../src/renderer/features/review-analysis-proposals/model/analysisProposal.schema';
import { proposalJsonHash } from '../../src/renderer/features/review-analysis-proposals/model/proposalReports';
import type { KnowledgeValue } from '../../src/shared/contracts/knowledge.contract';

export type FixtureMode =
  | 'v1'
  | 'v2'
  | 'stale'
  | 'tampered'
  | 'malformed'
  | 'wrong_quote'
  | 'wrong_target'
  | 'changed_candidate'
  | 'normalized_only';
export const sourceContent =
  '# 검토 합성 원문\n센서는 조건 A에서 경고를 보낸다.\n조건 B의 동작은 정해지지 않았다.\n추가 범위는 별도 확인한다.\n';

/** 후보와 실행 참조·원문/진단 hash를 실제 제품 검증기로 확인할 수 있는 합성 자료입니다. */
export async function fixture(mode: FixtureMode): Promise<ProposalRecord> {
  const rules = {
    ruleset_id: 'fixture',
    ruleset_version: '1',
    ruleset_revision: 'd'.repeat(64),
  };
  const candidate = {
    candidate_id: 'b'.repeat(32),
    candidate_revision: 'b'.repeat(64),
  };
  const relation = {
    subject: 'sensor',
    predicate: 'produces',
    object: 'warning',
    evidence: '센서는 조건 A에서 경고를 보낸다.',
    condition: null,
  };
  const submission: KnowledgeValue = {
    schema_version: 6,
    entities: [
      { id: 'sensor', label: '센서', type: 'component' },
      { id: 'warning', label: '경고', type: 'signal' },
    ],
    relations: [relation],
    attributes: [],
    relation_candidates: [],
  };
  const diagnostic: KnowledgeValue = {
    schema_version: mode === 'v1' ? 1 : 2,
    reviewer_kind: 'ai_self_check',
    warnings: ['조건 표현을 원문과 다시 대조해야 합니다.'],
    omissions: ['추가 범위는 별도 확인한다는 문장이 구조화되지 않았습니다.'],
    unread_ranges: ['첨부 2쪽의 글자를 확인하지 못했습니다.'],
    reviewed_ranges: [{ start_line: 1, end_line: 4 }],
    findings: [
      {
        rule_id: 'R-S01',
        verdict: 'condition_loss',
        source: {
          start_line: 2,
          end_line: 2,
          quote:
            mode === 'wrong_quote'
              ? '원문에 없는 문장입니다.'
              : '센서는 조건 A에서 경고를 보낸다.',
        },
        target: {
          collection: 'relations',
          index: mode === 'wrong_target' ? 999 : 0,
        },
        reason: '후보에서 조건 A가 빠졌습니다.',
        recommendation: '관계의 조건을 원문과 대조해 보완하세요.',
        question: '조건 A가 충족될 때만 경고를 보내나요?',
      },
      {
        rule_id: 'R-S02',
        verdict: 'ambiguous',
        source: null,
        target: null,
        reason: '조건 B 동작의 의미 판단은 미결입니다.',
        recommendation: null,
        question: '조건 B의 추가 근거가 있나요?',
      },
    ],
  };
  if (mode !== 'v1') {
    diagnostic.rule_results = Array.from(
      { length: 10 },
      (_: unknown, index: number): KnowledgeValue => ({
        rule_id: `R-S${String(index + 1).padStart(2, '0')}`,
        status: index === 0 ? 'fail' : 'not_run',
        reason:
          index === 0
            ? '조건을 잃었습니다.'
            : '이 규칙의 별도 검토는 미실행입니다.',
        finding_indices: index < 2 ? [index] : [],
      }),
    );
    diagnostic.semantic_check = null;
  }
  if (mode === 'malformed')
    diagnostic.findings = [
      { rule_id: 'R-S01', verdict: 'invented', reason: '유효하지 않은 보고' },
    ];
  const diagnosticHash = await proposalJsonHash(diagnostic);
  const ref = {
    proposal_id: 'a'.repeat(32),
    input_revision: '1'.repeat(64),
    proposal_state_revision: '2'.repeat(64),
    execution_id: 'c'.repeat(32),
    execution_revision: '3'.repeat(64),
    job_id: 'd'.repeat(32),
    run_id: 'e'.repeat(32),
    bundle_id: 'f'.repeat(32),
    bundle_revision: '4'.repeat(64),
    request_id: '1'.repeat(32),
    payload_hash: '5'.repeat(64),
    submission_sha256: await proposalJsonHash(submission),
    source_revision: '6'.repeat(64),
    ruleset_ref: rules,
    result_receipt_revision: '7'.repeat(64),
    diagnostic_report_hash: diagnosticHash,
    human_approval: false,
    origin: 'client_reported',
  };
  if (mode === 'tampered') diagnostic.warnings = ['改ざんされた警告は表示禁止'];
  const report = {
    validation_report: {
      automatic: 'pass',
      semantic: 'client_reported',
      basis: {
        job_id: ref.job_id,
        run_id: ref.run_id,
        bundle_id: ref.bundle_id,
        bundle_revision: ref.bundle_revision,
        source_revision: ref.source_revision,
        submission_sha256: ref.submission_sha256,
      },
      rule_results: [
        {
          rule_id: 'R-A01',
          status: 'pass',
          checker: 'server',
          reason: '구조와 인용 위치 검사',
        },
      ],
    },
    diagnostics:
      mode === 'normalized_only'
        ? { semantic: diagnostic }
        : { report: diagnostic, report_hash: diagnosticHash },
  };
  return proposalSchema.parse({
    proposal_id: ref.proposal_id,
    state_revision: '2'.repeat(64),
    input_revision: ref.input_revision,
    basis_status: 'current',
    active_execution_id: ref.execution_id,
    basis: {
      target_document: 'diagnostic.md',
      ruleset_ref: rules,
      documents: [
        {
          document: 'diagnostic.md',
          source: { revision: ref.source_revision, content: sourceContent },
        },
      ],
      previous: {
        status: 'missing',
        graph: null,
        claims: [],
        source: null,
        source_restoration: 'not_available',
      },
    },
    candidate_ref:
      mode === 'changed_candidate'
        ? { ...candidate, candidate_revision: 'c'.repeat(64) }
        : candidate,
    submission,
    preview_claims: [
      {
        claim_id: '9'.repeat(64),
        collection: 'relations',
        value: relation,
        decision: 'unreviewed',
      },
    ],
    missing_claims: [],
    decisions: [],
    events: [],
    applications: {},
    submission_schema: {},
    rules_components: {},
    human_approval: false,
    semantic_validation: 'client_reported',
    result_links: [
      {
        request_id: ref.request_id,
        execution_id: ref.execution_id,
        candidate_ref: candidate,
        result_ref: ref,
        currentness: mode === 'stale' ? 'candidate_changed' : 'current',
        candidate_current: mode !== 'stale',
        basis_current: true,
        execution_current: true,
        run_current: true,
        job_cancelled: false,
      },
    ],
    current_reports: [
      {
        proposal_id: ref.proposal_id,
        request_id: ref.request_id,
        execution_id: ref.execution_id,
        candidate_ref: candidate,
        result_ref: ref,
        linked: true,
        state: 'complete',
        state_revision: '2'.repeat(64),
        saved: false,
        canonical_changed: false,
        report_revision: '8'.repeat(64),
        report,
      },
    ],
  });
}
