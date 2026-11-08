import type { JSX } from 'react';
import { Link, useLocation } from 'react-router';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { documentEvidenceLink } from '@renderer/shared/lib/documentEvidence';
import type {
  DocumentKnowledge,
  KnowledgeJson,
} from '@contracts/knowledge.contract';
import type {
  MapAssertion,
  MapConcept,
  OntologyScope,
} from '../model/ontologyMap.types';
import { OntologyGlossaryCard } from './OntologyGlossaryCard';
import { OntologyValue } from './OntologyValue';
import { sourceAnchorValue } from '../model/sourceAnchors';
import { ontologyQualifications } from '../model/ontologyQualifications';
import { valueObject } from '../model/buildOntologyGraph';
import {
  ontologyClaimLabel,
  ontologyProvenanceValue,
  ontologyValueLabel,
  ontologyTermLabel,
  ontologyQualifierSummary,
} from '../model/ontologyLabels';
import styles from './OntologyMapWorkspace.module.scss';

type OntologyConceptDetailsProps = {
  concept: MapConcept;
  assertions: MapAssertion[];
  knowledge: DocumentKnowledge | null;
  scope: OntologyScope | null;
  active: boolean;
  onScopeInvalidated: () => void;
  onSelectAssertion: (assertion: MapAssertion) => void;
  /** 지도의 중심이 아닌 개념일 때만 주어지며 그 개념을 지도 중심으로 옮깁니다. */
  onMove?: (concept: MapConcept) => void;
};

/** 선택 개념의 관계와 속성을 읽기 목록으로 제공하고 각 항목에서 기존 근거 상세로 연결합니다. */
export function OntologyConceptDetails({
  concept,
  assertions,
  knowledge,
  scope,
  active,
  onScopeInvalidated,
  onSelectAssertion,
  onMove,
}: OntologyConceptDetailsProps): JSX.Element {
  const location = useLocation();
  const related = assertions.filter(
    (assertion: MapAssertion): boolean =>
      assertion.subject === concept.key || assertion.object === concept.key,
  );
  const relations = related.filter(
    (assertion: MapAssertion): boolean => assertion.collection !== 'attributes',
  );
  const attributes = related.filter(
    (assertion: MapAssertion): boolean => assertion.collection === 'attributes',
  );
  const anchorValueObject = valueObject(concept.entity.anchor);
  const anchor =
    anchorValueObject?.kind === 'source_anchor' ? anchorValueObject : null;
  const anchorValue = anchor ? sourceAnchorValue(anchor) : undefined;
  const evidenceLink = knowledge
    ? documentEvidenceLink(
        concept.document,
        knowledge.sourceRevision,
        anchor ?? concept.entity.evidence,
        location.pathname + location.search,
      )
    : { to: `/document?path=${encodeURIComponent(concept.document)}` };
  const provenance = ontologyProvenanceValue(
    concept.entity.provenance,
    knowledge?.effectiveGraph.entities ?? [concept.entity],
  );
  const additional = Object.fromEntries(
    Object.entries(concept.entity).filter(
      ([key]: [string, KnowledgeJson]): boolean =>
        ![
          'id',
          'label',
          'type',
          'context',
          'identifiers',
          'evidence',
          'anchor',
          'status',
          'provenance',
        ].includes(key),
    ),
  );
  return (
    <div className={styles.conceptDetail}>
      <div className={styles.conceptHeading}>
        <h3>{concept.entity.label}</h3>
        <span>{ontologyTermLabel(concept.entity.type)}</span>
        <Link {...evidenceLink}>
          <Icon name="file-text" size={14} />
          {documentDisplayName(concept.document)}
        </Link>
      </div>
      {onMove && (
        <div className={styles.goMove}>
          <button type="button" onClick={(): void => onMove(concept)}>
            이 개념 중심으로 보기
          </button>
        </div>
      )}
      {anchor ? (
        <section aria-label="원문 근거 내용">
          <h3>원문 근거</h3>
          <p className={styles.muted}>
            이 표시는 문서의 원문 위치를 가리킵니다.
          </p>
          {anchorValue !== null && typeof anchorValue === 'object' ? (
            <details className={styles.referenceDisclosure}>
              <summary>원문 메타데이터 보기</summary>
              <OntologyValue value={anchorValue} />
            </details>
          ) : (
            <blockquote className={styles.anchorQuote}>
              <OntologyValue value={anchorValue} />
            </blockquote>
          )}
        </section>
      ) : (
        <OntologyGlossaryCard
          concept={concept}
          knowledge={knowledge}
          scope={scope}
          active={active}
          onScopeInvalidated={onScopeInvalidated}
        />
      )}
      {provenance && (
        <section aria-label="출처와 귀속">
          <h3>출처와 귀속</h3>
          <OntologyValue value={provenance} />
        </section>
      )}
      {Object.keys(additional).length > 0 && (
        <section aria-label="추가 개념 정보">
          <h3>추가 개념 정보</h3>
          <OntologyValue value={additional} />
        </section>
      )}
      <section aria-label="연결된 관계">
        <h3>
          연결된 관계 <span>{relations.length}</span>
        </h3>
        <ul className={styles.connectionList}>
          {relations.map((assertion: MapAssertion): JSX.Element => (
            <li key={assertion.key}>
              <button
                type="button"
                onClick={(): void => onSelectAssertion(assertion)}
              >
                <span className={styles.connectionText}>
                  <strong>
                    {ontologyClaimLabel(
                      assertion.value,
                      assertion.knowledge.effectiveGraph.entities,
                    )}
                  </strong>
                  {ontologyQualifierSummary(assertion.value) && (
                    <span className={styles.conditionSummary}>
                      {ontologyQualifierSummary(assertion.value)}
                    </span>
                  )}
                  <small className={styles.connectionMeta}>
                    <span className={styles[assertion.origin]}>
                      {assertion.claim?.authored_kind === 'source'
                        ? '원문 근거 추가'
                        : assertion.origin === 'candidate'
                          ? '연결 후보 · 미확정'
                          : assertion.origin === 'expert'
                            ? '검토·판단 반영'
                            : 'AI 추출'}
                    </span>
                    {ontologyQualifications(
                      valueObject(assertion.value.qualifiers),
                    ).map((label: string): JSX.Element => (
                      <span key={label}>{label}</span>
                    ))}
                    <span>
                      {assertion.subject === concept.key
                        ? '나가는 관계'
                        : '들어오는 관계'}
                    </span>
                  </small>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            </li>
          ))}
        </ul>
        {relations.length === 0 && (
          <p className={styles.muted}>
            현재 조회 범위에 연결된 관계가 없습니다.
          </p>
        )}
      </section>
      <section aria-label="속성 주장">
        <h3>
          속성 <span>{attributes.length}</span>
        </h3>
        <ul className={styles.connectionList}>
          {attributes.map((assertion: MapAssertion): JSX.Element => (
            <li key={assertion.key}>
              <button
                type="button"
                onClick={(): void => onSelectAssertion(assertion)}
              >
                <span className={styles.connectionText}>
                  <strong>{assertion.label}</strong>
                  <small>
                    {ontologyValueLabel(assertion.value.value)}{' '}
                    {assertion.value.unit != null
                      ? ontologyValueLabel(assertion.value.unit)
                      : ''}
                  </small>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            </li>
          ))}
        </ul>
        {attributes.length === 0 && (
          <p className={styles.muted}>현재 조회 범위에 속성 주장이 없습니다.</p>
        )}
      </section>
    </div>
  );
}
