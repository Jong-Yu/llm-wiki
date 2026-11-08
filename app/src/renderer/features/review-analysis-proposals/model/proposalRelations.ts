import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type {
  ProposalClaim,
  ProposalRecord,
  ProposalValidation,
} from './analysisProposal.schema';

export type ProposalRelations = {
  added: ProposalClaim[];
  removed: ProposalClaim[];
  same: ProposalClaim[];
  undecidedIds: string[];
  decisionLabels: Map<string, string | null>;
};
const actionLabels: Record<string, string> = {
  keep: '복구 초안',
  exclude: '이번 비교에서 제외',
  reextract: '재추출 요청 기록',
};

/** 서버의 비교 구분과 최신 판단을 한 번 집계해 건수·행·반영 조건에서 공유합니다. */
export function proposalRelations(
  record: ProposalRecord | null,
): ProposalRelations {
  const result: ProposalRelations = {
    added: [],
    removed: record?.missing_claims ?? [],
    same: [],
    undecidedIds: [],
    decisionLabels: new Map(),
  };
  if (!record) return result;
  const previousIds = new Set(
    record.basis.previous.claims.map(
      (claim: ProposalClaim): string => claim.claim_id,
    ),
  );
  for (const claim of record.preview_claims)
    (previousIds.has(claim.claim_id) ? result.same : result.added).push(claim);
  const latestDecisions = new Map<unknown, KnowledgeValue>();
  for (const decision of record.decisions)
    latestDecisions.set(decision.old_claim_id, decision);
  for (const claim of result.removed) {
    if (!latestDecisions.has(claim.claim_id))
      result.undecidedIds.push(claim.claim_id);
    const action = latestDecisions.get(claim.claim_id)?.action;
    result.decisionLabels.set(
      claim.claim_id,
      typeof action === 'string' ? (actionLabels[action] ?? action) : null,
    );
  }
  return result;
}

/** 현재 후보와 정확히 같은 서버 검사가 통과일 때만 참입니다. */
export function automaticCheckPassed(
  record: ProposalRecord,
  validation: ProposalValidation | null,
): boolean {
  return (
    !!validation &&
    validation.automatic === 'passed' &&
    validation.proposal_id === record.proposal_id &&
    validation.state_revision === record.state_revision &&
    validation.candidate_ref.candidate_revision ===
      record.candidate_ref?.candidate_revision
  );
}
