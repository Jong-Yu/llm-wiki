import type { JSX } from 'react';
import { Link, useLocation } from 'react-router';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import { SkeletonText } from '@renderer/shared/ui/Skeleton';
import { documentEvidenceLink } from '@renderer/shared/lib/documentEvidence';
import type { MapConcept, OntologyScope } from '../model/ontologyMap.types';
import { useOntologyGlossary } from '../model/useOntologyGlossary';
import { OntologyConceptMeaning } from './OntologyConceptMeaning';
import { OntologyCoverageNotice } from './OntologyCoverageNotice';
import styles from './OntologyGlossaryCard.module.scss';
import common from './OntologyMapWorkspace.module.scss';

type OntologyGlossaryCardProps = {
  concept: MapConcept;
  knowledge: DocumentKnowledge | null;
  scope: OntologyScope | null;
  active: boolean;
  onScopeInvalidated: () => void;
};

/** 이미 읽은 원문 정보는 유지하고 추가 조회한 문맥을 같은 표시에서 읽습니다. */
export function OntologyGlossaryCard({
  concept,
  knowledge,
  scope,
  active,
  onScopeInvalidated,
}: OntologyGlossaryCardProps): JSX.Element | null {
  const location = useLocation();
  const { loading, card, error } = useOntologyGlossary(
    concept,
    knowledge,
    scope,
    active,
    onScopeInvalidated,
  );
  if (!active) return null;
  const entity = card?.entity ?? concept.entity;
  const quote =
    typeof entity.evidence === 'string'
      ? entity.evidence
      : typeof entity.evidence === 'object' &&
          entity.evidence !== null &&
          !Array.isArray(entity.evidence) &&
          typeof entity.evidence.quote === 'string'
        ? entity.evidence.quote
        : card?.source_passage?.quote;
  const structured =
    typeof quote === 'string' && /^\s*(?:\{|\[|"[^"\n]+"\s*:)/.test(quote);
  return (
    <section className={styles.card} aria-label="원문 문맥" aria-busy={loading}>
      <h3>원문 문맥</h3>
      <p className={common.muted}>
        {structured
          ? '구조화된 원문의 일부입니다. 앞뒤 문맥이나 원문을 함께 확인해 주세요.'
          : '개념이 언급된 원문 표현과 앞뒤 문맥을 확인합니다.'}
      </p>
      {loading && (
        <div role="status" aria-label="용어 설명 불러오는 중">
          <SkeletonText lines={3} />
        </div>
      )}
      {error && (
        <p role="alert">
          {error.code === 'catalog_changed' || error.status === 409
            ? '개념의 판본이 변경되었습니다. 상세를 닫고 개념을 다시 불러와 주세요.'
            : error.status === 403
              ? '현재 권한으로 추가 원문 문맥을 볼 수 없습니다.'
              : error.message}
        </p>
      )}
      <OntologyConceptMeaning
        entity={card?.entity ?? concept.entity}
        passage={card?.source_passage}
      />
      <p className={styles.sourceLink}>
        {card?.source_passage && (
          <span>
            원문 문맥 {card.source_passage.start_line}–
            {card.source_passage.end_line}행
          </span>
        )}
        <Link
          {...documentEvidenceLink(
            concept.document,
            card?.source_passage?.source_revision ??
              card?.document.source_revision ??
              knowledge?.sourceRevision ??
              '',
            entity.evidence ?? card?.source_passage,
            `${location.pathname}${location.search}`,
          )}
        >
          원문 위치 열기
        </Link>
      </p>
      {card?.source_passage_status === 'limited' && (
        <p role="status" className={common.muted}>
          문단이 길어 개념에 연결된 인용만 표시합니다. 전체 문맥은 원문에서
          확인해 주세요.
        </p>
      )}
      {card && (
        <OntologyCoverageNotice
          coverage={card.coverage}
          scope="이 문서의 원문·검토 조회"
        />
      )}
    </section>
  );
}
