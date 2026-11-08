import type { JSX } from 'react';
import type { CorrectionBasis } from '../model/ontologyMap.types';
import { OntologyAssertionDetails } from './OntologyAssertionDetails';
import styles from './OntologyMapWorkspace.module.scss';

type OntologyReferencePaneProps = {
  basis: CorrectionBasis;
  fullSource?: boolean;
};

/** 판단 입력 옆에 고정 판본의 근거를 두고 전체 원문과 조건도 같은 위치에서 확인합니다. */
export function OntologyReferencePane({
  basis,
  fullSource = false,
}: OntologyReferencePaneProps): JSX.Element {
  return (
    <section
      className={styles.referencePane}
      aria-label={fullSource ? '정정 기준 원문' : '검토할 근거'}
      data-ontology-reference
    >
      {fullSource ? (
        <>
          <h2>정정 기준 원문</h2>
          <pre
            className={styles.referenceText}
            role="region"
            tabIndex={0}
            aria-label="정정 기준 원문 본문"
          >
            {basis.body}
          </pre>
        </>
      ) : (
        <OntologyAssertionDetails
          assertion={basis.assertion}
          section="evidence"
          headingLevel={2}
        />
      )}
      <details className={styles.referenceDisclosure}>
        <summary>
          {fullSource ? '현재 추출의 근거와 조건' : '조건과 적용 범위'}
        </summary>
        {fullSource && (
          <OntologyAssertionDetails
            assertion={basis.assertion}
            section="evidence"
          />
        )}
        <OntologyAssertionDetails
          assertion={basis.assertion}
          section="context"
        />
      </details>
      {!fullSource && (
        <details className={styles.referenceDisclosure}>
          <summary>검토 기준 원문 전체</summary>
          <pre
            className={styles.referenceText}
            role="region"
            tabIndex={0}
            aria-label="검토 기준 원문 본문"
          >
            {basis.body}
          </pre>
        </details>
      )}
    </section>
  );
}
