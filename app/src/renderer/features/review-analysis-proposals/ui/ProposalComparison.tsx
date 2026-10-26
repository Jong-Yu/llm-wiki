import type { JSX } from 'react';
import type {
  ProposalRecord,
  ProposalClaim,
} from '../model/analysisProposal.schema';
import styles from './ReviewAnalysisProposals.module.scss';

type ProposalComparisonProps = {
  previous: ProposalRecord;
  next: ProposalRecord;
};
/** 전체 후보를 양쪽에 보존하고 ID 차이를 의미 대응이나 승인 승계로 해석하지 않습니다. */
export function ProposalComparison({
  previous,
  next,
}: ProposalComparisonProps): JSX.Element {
  const previousIds = new Set(
    previous.preview_claims.map(
      (claim: ProposalClaim): string => claim.claim_id,
    ),
  );
  const nextIds = new Set(
    next.preview_claims.map((claim: ProposalClaim): string => claim.claim_id),
  );
  const added = [...nextIds].filter(
    (id: string): boolean => !previousIds.has(id),
  ).length;
  const missing = [...previousIds].filter(
    (id: string): boolean => !nextIds.has(id),
  ).length;
  return (
    <section aria-label="이전 후보와 새 후보 비교">
      <h3>이전 후보와 새 후보</h3>
      <p>
        새 ID {added}개 · 이전에만 있는 ID {missing}개. 인용이 바뀐 주장의 의미
        대응은 별도 확인합니다.
      </p>
      <div className={styles.pair}>
        <section>
          <h4>이전 편집 기준</h4>
          <code>
            {previous.candidate_ref?.candidate_revision ?? '후보 없음'}
          </code>
          <pre>{JSON.stringify(previous.submission, null, 2)}</pre>
        </section>
        <section>
          <h4>서버에서 확인한 새 후보</h4>
          <code>{next.candidate_ref?.candidate_revision ?? '후보 없음'}</code>
          <pre>{JSON.stringify(next.submission, null, 2)}</pre>
        </section>
      </div>
      <p>
        새 후보를 편집 기준으로 선택한 뒤 검증·명시 적용·새 주장 검토를
        진행합니다.
      </p>
    </section>
  );
}
