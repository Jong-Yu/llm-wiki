import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type {
  MapAssertion,
  MapConcept,
  OntologyGraph,
} from './ontologyMap.types';
import { sourceAnchorLabel } from './sourceAnchors';
import { relationPredicateLabel } from './ontologyRelation.schema';

/** JSON 객체를 좁혀 저장된 한정어와 근거를 안전하게 읽습니다. */
export function valueObject(
  value: KnowledgeJson | undefined,
): KnowledgeValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** 문자열이 아닌 업무 값은 표시 단계에서만 직렬화합니다. */
export function displayValue(value: KnowledgeJson | undefined): string {
  return value === undefined || value === null
    ? '미지정'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
}

/** 관계 이름은 확정된 한국어 이름표로, 속성 이름 등은 저장된 그대로 표시합니다. */
export function predicateText(value: KnowledgeJson | undefined): string {
  return typeof value === 'string'
    ? relationPredicateLabel(value)
    : displayValue(value);
}

/** 문서와 개체 ID를 함께 사용하여 이름이 같은 다른 개념을 구분합니다. */
export function conceptKey(document: string, id: string): string {
  return JSON.stringify([document, id]);
}

/** JSON 키 순서 차이를 무시하되 실제 업무 필드는 모두 비교합니다. */
function canonical(value: KnowledgeJson): string {
  if (Array.isArray(value))
    return `[${value.map((item: KnowledgeJson): string => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key: string): string =>
          `${JSON.stringify(key)}:${canonical(value[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/** 현재 유효층에 있는 유일한 주장만 편집 대상에 연결합니다. */
function matchingClaim(
  knowledge: DocumentKnowledge,
  collection: KnowledgeClaim['collection'],
  value: KnowledgeValue,
): KnowledgeClaim | null {
  const matches = (knowledge.currentClaims ?? knowledge.claims).filter(
    (claim: KnowledgeClaim): boolean => {
      if (claim.decision === 'reject' || claim.decision === 'defer')
        return false;
      const effectiveCollection =
        claim.collection === 'relation_candidates' &&
        ['accept', 'edit'].includes(claim.decision)
          ? 'relations'
          : claim.collection;
      return (
        effectiveCollection === collection &&
        canonical(claim.reviewed_value) === canonical(value)
      );
    },
  );
  return matches.length === 1 ? matches[0] : null;
}

/** 실제 원문 앵커를 별도 표시 노드로 유지하여 연결을 조용히 생략하지 않습니다. */
function endpointKey(
  value: KnowledgeJson | undefined,
  document: string,
  concepts: MapConcept[],
): string | null {
  if (typeof value === 'string') return conceptKey(document, value);
  const anchor = valueObject(value);
  if (!anchor || anchor.kind !== 'source_anchor') return null;
  const key = JSON.stringify([document, 'source_anchor', canonical(anchor)]);
  if (!concepts.some((concept: MapConcept): boolean => concept.key === key))
    concepts.push({
      key,
      document,
      entity: {
        id: key,
        label: sourceAnchorLabel(anchor),
        type: '원문 근거',
        anchor,
      },
    });
  return key;
}

/** 서버가 제공한 현재 유효 주장만 표시하며 후보와 전문가 출처를 보존합니다. */
export function buildOntologyGraph(
  documents: DocumentKnowledge[],
): OntologyGraph {
  const concepts: MapConcept[] = [];
  const assertions: MapAssertion[] = [];
  for (const knowledge of documents) {
    for (const entity of knowledge.effectiveGraph.entities)
      concepts.push({
        key: conceptKey(knowledge.document, entity.id),
        document: knowledge.document,
        entity,
      });
    for (const collection of [
      'relations',
      'attributes',
      'relation_candidates',
    ] as const) {
      knowledge.effectiveGraph[collection].forEach(
        (value: KnowledgeValue, index: number): void => {
          const subject = endpointKey(
            value.subject,
            knowledge.document,
            concepts,
          );
          if (!subject) return;
          const claim = matchingClaim(knowledge, collection, value);
          assertions.push({
            key: JSON.stringify([
              knowledge.document,
              collection,
              claim?.claim_id || index,
            ]),
            document: knowledge.document,
            subject,
            object:
              collection === 'attributes'
                ? null
                : endpointKey(value.object, knowledge.document, concepts),
            label: predicateText(
              value.predicate ?? value.property ?? value.question,
            ),
            origin:
              collection === 'relation_candidates'
                ? 'candidate'
                : claim?.decision === 'policy' ||
                    !!claim?.authored_event_id ||
                    !!claim?.review_event_id ||
                    valueObject(value.provenance)?.kind === 'expert_policy'
                  ? 'expert'
                  : 'machine',
            collection,
            value,
            claim,
            knowledge,
          });
        },
      );
    }
  }
  return { concepts, assertions };
}
