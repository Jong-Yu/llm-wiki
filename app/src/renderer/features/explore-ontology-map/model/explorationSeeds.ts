import type { ExplorationSeed } from './useOntologyExploration';
import { conceptKey } from './buildOntologyGraph';

/** 이미 읽은 개체가 속한 주제를 찾아 무관한 현재 초점을 이동 출발점으로 쓰지 않습니다. */
export function explorationTopicKey(
  items: ExplorationSeed[],
  targetKey: string,
  preferredKey: string | null,
): string | null {
  const direct = items.find(
    (seed: ExplorationSeed): boolean =>
      conceptKey(seed.concept.document, seed.concept.entity_id) === targetKey,
  );
  if (direct) return targetKey;
  const containsTarget = (seed: ExplorationSeed): boolean =>
    seed.concepts.some(
      (concept: ExplorationSeed['concept']): boolean =>
        conceptKey(concept.document, concept.entity_id) === targetKey,
    );
  const preferred = items.find(
    (seed: ExplorationSeed): boolean =>
      conceptKey(seed.concept.document, seed.concept.entity_id) ===
      preferredKey,
  );
  if (preferred && containsTarget(preferred)) return preferredKey;
  const containing = items.find(containsTarget);
  return containing
    ? conceptKey(containing.concept.document, containing.concept.entity_id)
    : null;
}

/** 관계 이동은 현재 주제의 중심만 교체하고, 검색 추가는 별도 주제를 유지합니다. */
export function applyExplorationSeed(
  items: ExplorationSeed[],
  next: ExplorationSeed,
  replaceKey: string | null = null,
): ExplorationSeed[] {
  const nextKey = conceptKey(next.concept.document, next.concept.entity_id);
  if (
    replaceKey &&
    !items.some(
      (seed: ExplorationSeed): boolean =>
        conceptKey(seed.concept.document, seed.concept.entity_id) ===
        replaceKey,
    )
  )
    return items;
  const result: ExplorationSeed[] = [];
  let inserted = false;
  for (const seed of items) {
    const key = conceptKey(seed.concept.document, seed.concept.entity_id);
    if (key === replaceKey || key === nextKey) {
      if (!inserted) {
        result.push(next);
        inserted = true;
      }
    } else if (
      seed.concept.document !== next.concept.document ||
      seed.concept.ref.state_revision === next.concept.ref.state_revision
    )
      result.push(seed);
  }
  if (!inserted) result.push(next);
  return result;
}
