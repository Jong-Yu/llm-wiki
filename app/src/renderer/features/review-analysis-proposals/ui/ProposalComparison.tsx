import type { JSX } from 'react';
import type {
  ProposalRecord,
  ProposalClaim,
} from '../model/analysisProposal.schema';
import styles from './ReviewAnalysisProposals.module.scss';
import { ProposalGraphDetails } from './ProposalGraphDetails';
import { describeClaim } from './ProposalClaimSummary';
import type { ClaimParts } from './ProposalClaimSummary';

type ProposalComparisonProps = {
  previous: ProposalRecord;
  next: ProposalRecord;
};
type Described = { claim: ProposalClaim; parts: ClaimParts; key: string };

/** 주체·관계·대상이 같으면 같은 관계로 보며 근거 문장만 바뀐 경우는 사라짐+추가로 나뉩니다. */
function describeAll(record: ProposalRecord): Described[] {
  return record.preview_claims.map((claim: ProposalClaim): Described => {
    const parts = describeClaim(claim.value, record.submission);
    return {
      claim,
      parts,
      key: `${parts.subject}\u0000${parts.relation}\u0000${parts.target}`,
    };
  });
}

/** 관계 한 줄: 주체 → 관계 → 대상. */
function RelationRow({ item }: { item: Described }): JSX.Element {
  return (
    <li>
      <strong>{item.parts.subject}</strong> <span>{item.parts.relation} →</span>{' '}
      <strong>{item.parts.target}</strong>
    </li>
  );
}

/** 이전 추출과 새 추출을 "추가 · 사라짐 · 그대로" 세 묶음으로 비교합니다. */
export function ProposalComparison({
  previous,
  next,
}: ProposalComparisonProps): JSX.Element {
  const before = describeAll(previous);
  const after = describeAll(next);
  const beforeKeys = new Set(before.map((item: Described): string => item.key));
  const afterKeys = new Set(after.map((item: Described): string => item.key));
  const added = after.filter(
    (item: Described): boolean => !beforeKeys.has(item.key),
  );
  const removed = before.filter(
    (item: Described): boolean => !afterKeys.has(item.key),
  );
  const same = after.filter((item: Described): boolean =>
    beforeKeys.has(item.key),
  );
  return (
    <section aria-label="관계 추출 결과 비교">
      <h3>관계 추출 결과 비교</h3>
      <p>
        추가 {added.length} · 사라짐 {removed.length} · 그대로 {same.length}.
        근거 문장만 바뀐 관계는 사라짐과 추가로 나뉘어 보일 수 있습니다.
      </p>
      <section>
        <h4>추가된 관계 {added.length}</h4>
        <ul className={styles.claimList}>
          {added.map((item: Described): JSX.Element => (
            <RelationRow key={item.claim.claim_id} item={item} />
          ))}
        </ul>
      </section>
      <section>
        <h4>사라진 관계 {removed.length}</h4>
        <ul className={styles.claimList}>
          {removed.map((item: Described): JSX.Element => (
            <RelationRow key={item.claim.claim_id} item={item} />
          ))}
        </ul>
      </section>
      <details>
        <summary>그대로인 관계 {same.length}</summary>
        <ul className={styles.claimList}>
          {same.map((item: Described): JSX.Element => (
            <RelationRow key={item.claim.claim_id} item={item} />
          ))}
        </ul>
      </details>
      <details>
        <summary>이전과 새 추출의 전체 내용·근거</summary>
        <h4>이전 추출</h4>
        <ProposalGraphDetails graph={previous.submission} />
        <h4>새 추출</h4>
        <ProposalGraphDetails graph={next.submission} />
      </details>
      <p>
        반영하면 관계가 새 버전으로 바뀌고, 이전에 확인한 관계의 검토 결과는 새
        버전으로 옮겨지지 않습니다.
      </p>
    </section>
  );
}
