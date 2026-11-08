import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { displayValue, valueObject } from './buildOntologyGraph';
import type { MapAssertion } from './ontologyMap.types';

/** 현재 표시와 감사용 과거 대상은 별도 목록으로 두어 정리 결과를 되살리지 않습니다. */
export function historicalReviewTargets(
  knowledge: DocumentKnowledge,
): KnowledgeClaim[] {
  const current = new Set(
    (knowledge.currentClaims ?? knowledge.claims).map(
      (claim: KnowledgeClaim): string => claim.claim_id,
    ),
  );
  const targets = new Map<string, KnowledgeClaim>();
  for (const event of [
    ...knowledge.history,
    ...(knowledge.relationHistory ?? []),
  ]) {
    if (typeof event.claim_id !== 'string' || current.has(event.claim_id))
      continue;
    const value =
      valueObject(valueObject(event.target)?.claim) ?? valueObject(event.value);
    if (!value) continue;
    const collection =
      event.collection === 'attributes' ||
      event.collection === 'relation_candidates'
        ? event.collection
        : 'relations';
    const addition =
      event.action === 'relation_create' || event.action === 'relation_undo';
    targets.set(event.claim_id, {
      claim_id: event.claim_id,
      collection,
      value,
      reviewed_value: value,
      decision: 'past',
      review_event_id: null,
      ambiguous: false,
      needs_review: true,
      ...(addition
        ? {
            authored_event_id: event.id ?? null,
            authored_kind: event.kind ?? null,
          }
        : {}),
    });
  }
  return [...targets.values()];
}

/** 문서와 주장 ID를 함께 유지하여 같은 이름의 다른 관계로 이동하지 않습니다. */
export function reviewAssertion(
  knowledge: DocumentKnowledge,
  claim: KnowledgeClaim,
): MapAssertion {
  const value: KnowledgeValue = claim.reviewed_value;
  return {
    key: claim.claim_id,
    document: knowledge.document,
    knowledge,
    claim,
    value,
    subject: '',
    object: null,
    label: displayValue(value.predicate ?? value.property),
    collection: claim.collection,
    origin:
      claim.collection === 'relation_candidates'
        ? 'candidate'
        : claim.decision === 'policy' || !!claim.authored_event_id
          ? 'expert'
          : 'machine',
  };
}
