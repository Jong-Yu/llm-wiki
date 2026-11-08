import type { JSX, ReactNode } from 'react';
import type {
  ProposalClaim,
  ProposalRecord,
} from '../model/analysisProposal.schema';
import type { ProposalRelations } from '../model/proposalRelations';
import { Button } from '@renderer/shared/ui/Button';
import { ProposalClaimSummary } from './ProposalClaimSummary';
import styles from './ReviewAnalysisProposals.module.scss';

type ProposalRelationDiffProps = {
  record: ProposalRecord;
  /** 서버가 현재 후보에 대해 돌려준 자동 검사 결과. 없으면 표시하지 않습니다. */
  automaticPassed: boolean;
  relations: ProposalRelations;
  selectedId: string | null;
  onSelect: (claimId: string | null) => void;
  /** 선택한 사라진 관계 아래에 끼워 넣는 판단 폼. */
  renderDecision: (claim: ProposalClaim) => ReactNode;
};
/** 추가·사라짐·그대로 세 묶음과 사라진 관계의 판단을 한 화면에서 처리합니다. */
export function ProposalRelationDiff({
  record,
  automaticPassed,
  relations,
  selectedId,
  onSelect,
  renderDecision,
}: ProposalRelationDiffProps): JSX.Element {
  const { added, removed, same, undecidedIds, decisionLabels } = relations;
  const undecided = undecidedIds.length;
  return (
    <section aria-label="관계 추출 결과 비교" className={styles.diff}>
      <div className={styles.proposalSummary}>
        <span>추가 {added.length}</span>
        <span>사라짐 {removed.length}</span>
        <span>그대로 {same.length}</span>
        {automaticPassed && (
          <output className={styles.checkPassed}>자동 검사 통과</output>
        )}
      </div>
      <section>
        <h2>추가된 관계 {added.length}</h2>
        <ul className={styles.claimList}>
          {added.map((claim: ProposalClaim): JSX.Element => (
            <li key={claim.claim_id}>
              <ProposalClaimSummary
                value={claim.value}
                graph={record.submission}
              />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>
          사라진 관계 {removed.length}
          {undecided > 0 && ` · 판단이 필요합니다 ${undecided}`}
        </h2>
        {removed.length > 0 && (
          <p>
            이전에는 있었지만 이번 추출에는 없는 관계입니다. 사라진 이유는
            확정되지 않았으며, 복구·재추출·제외 중 이유와 함께 판단합니다.
          </p>
        )}
        <ul className={styles.removedList}>
          {removed.map((claim: ProposalClaim): JSX.Element => {
            const label = decisionLabels.get(claim.claim_id) ?? null;
            const open = selectedId === claim.claim_id;
            return (
              <li key={claim.claim_id} data-decided={label ? 'true' : 'false'}>
                <div className={styles.removedRow}>
                  <ProposalClaimSummary
                    value={claim.value}
                    graph={record.basis.previous.graph}
                  />
                  <span>{label ? `판단함 · ${label}` : '판단 필요'}</span>
                  <Button
                    variant="secondary"
                    aria-expanded={open}
                    onClick={(): void => onSelect(open ? null : claim.claim_id)}
                  >
                    {open ? '판단 닫기' : label ? '판단 추가' : '판단 입력'}
                  </Button>
                </div>
                {typeof claim.value.evidence === 'string' && (
                  <blockquote className={styles.claimQuote}>
                    {claim.value.evidence}
                  </blockquote>
                )}
                {open && renderDecision(claim)}
              </li>
            );
          })}
        </ul>
      </section>
      <details>
        <summary>그대로인 관계 {same.length}</summary>
        <ul className={styles.claimList}>
          {same.map((claim: ProposalClaim): JSX.Element => (
            <li key={claim.claim_id}>
              <ProposalClaimSummary
                value={claim.value}
                graph={record.submission}
              />
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
