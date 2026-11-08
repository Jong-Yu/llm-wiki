import type { JSX } from 'react';
import type {
  KnowledgeEntity,
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { valueObject } from '../model/buildOntologyGraph';
import { OntologyValue } from './OntologyValue';
import styles from './OntologyGlossaryCard.module.scss';
import common from './OntologyMapWorkspace.module.scss';

type OntologyConceptMeaningProps = {
  entity: KnowledgeEntity;
  passage?: { quote: string; start_line: number; end_line: number } | null;
};
const viewpoints: Record<string, string> = {
  business: '비즈니스',
  developer: '개발',
  architecture: '아키텍처',
};

/** 이미 읽은 개념의 인용·위치·맥락·식별자는 문맥 추가 조회가 없어도 표시합니다. */
export function OntologyConceptMeaning({
  entity,
  passage,
}: OntologyConceptMeaningProps): JSX.Element {
  const evidence = valueObject(entity.evidence);
  const quote =
    typeof entity.evidence === 'string'
      ? entity.evidence
      : typeof evidence?.quote === 'string'
        ? evidence.quote
        : passage?.quote;
  const location = evidence ?? passage;
  const context = valueObject(entity.context);
  const contextDetails = context
    ? {
        ...context,
        ...(Array.isArray(context.viewpoints)
          ? {
              viewpoints: context.viewpoints.map(
                (item: KnowledgeJson): KnowledgeJson =>
                  typeof item === 'string' ? (viewpoints[item] ?? item) : item,
              ),
            }
          : {}),
      }
    : null;
  const identifiers = Array.isArray(entity.identifiers)
    ? entity.identifiers.flatMap((item: KnowledgeJson): KnowledgeValue[] => {
        const identifier = valueObject(item);
        return identifier ? [identifier] : [];
      })
    : [];
  return (
    <div aria-label="개념의 원문 정보">
      {quote ? (
        <div className={common.evidence}>
          <blockquote>{quote}</blockquote>
          {typeof location?.start_line === 'number' && (
            <p className={styles.sourceLink}>
              원문 인용 {location.start_line}
              {typeof location.end_line === 'number' &&
              location.end_line !== location.start_line
                ? `–${location.end_line}`
                : ''}
              행
            </p>
          )}
          {typeof evidence?.occurrence === 'number' && (
            <OntologyValue value={{ occurrence: evidence.occurrence }} />
          )}
        </div>
      ) : entity.evidence !== undefined && entity.evidence !== null ? (
        <OntologyValue value={entity.evidence} />
      ) : (
        <p className={common.muted}>이 개념에 연결된 원문 인용이 없습니다.</p>
      )}
      {contextDetails && <OntologyValue value={contextDetails} />}
      {identifiers.length > 0 && (
        <div className={styles.identifiers}>
          <h4>식별 범위</h4>
          {identifiers.map(
            (identifier: KnowledgeValue, index: number): JSX.Element => (
              <OntologyValue key={index} value={identifier} />
            ),
          )}
        </div>
      )}
      {passage && quote !== passage.quote && (
        <details className={styles.passage}>
          <summary>앞뒤 원문 문맥 보기</summary>
          <blockquote>{passage.quote}</blockquote>
        </details>
      )}
    </div>
  );
}
