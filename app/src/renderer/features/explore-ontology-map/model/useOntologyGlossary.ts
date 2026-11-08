import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type {
  DocumentKnowledge,
  KnowledgeEntity,
} from '@contracts/knowledge.contract';
import type { OntologyGlossaryCard } from '@contracts/ontologyExploration.contract';
import { loadOntologyGlossary } from '../api/ontologyExploration.api';
import { invalidatesScope } from '../api/ontologyMap.api';
import type {
  MapConcept,
  OntologyFailure,
  OntologyOutcome,
  OntologyScope,
} from './ontologyMap.types';

type GlossaryState = {
  key: string;
  card: OntologyGlossaryCard | null;
  error: OntologyFailure | null;
};
type GlossaryView = {
  visible: boolean;
  loading: boolean;
  card: OntologyGlossaryCard | null;
  error: OntologyFailure | null;
};

/** 실제 개체를 선택한 동안만 조회하고 선택·연결·화면 수명이 끝난 응답은 폐기합니다. */
export function useOntologyGlossary(
  concept: MapConcept,
  knowledge: DocumentKnowledge | null,
  scope: OntologyScope | null,
  active: boolean,
  onScopeInvalidated: () => void,
): GlossaryView {
  const document = concept.document;
  const entityId = concept.entity.id;
  // 원문 앵커용 표시 노드를 API의 실제 entity_id로 사용하지 않습니다.
  const stateRevision =
    knowledge?.document === document &&
    knowledge.effectiveGraph.entities.some(
      (entity: KnowledgeEntity): boolean => entity.id === entityId,
    )
      ? knowledge.stateRevision
      : null;
  const [state, setState] = useState<GlossaryState | null>(null);
  const [epoch, setEpoch] = useState(0);
  const generation = useRef(0);
  const invalidateScope = useEffectEvent(onScopeInvalidated);
  const key = JSON.stringify([
    scope?.connectionId,
    scope?.userId,
    scope?.tenant,
    scope?.profileId,
    scope?.accessRevision ?? scope?.policyRevision,
    document,
    entityId,
    stateRevision,
    epoch,
  ]);
  const visible = active && scope !== null && stateRevision !== null;
  // 보관된 화면을 다시 열 때 이전 카드를 잠깐 노출하지 않도록 표시 수명에서 비웁니다.
  if (!visible && state !== null) setState(null);

  useEffect((): (() => void) => {
    const invalidate = (): void => {
      generation.current++;
      setState(null);
      setEpoch((value: number): number => value + 1);
    };
    window.addEventListener('wiki-connection-changed', invalidate);
    window.addEventListener('wiki-data-changed', invalidate);
    return (): void => {
      window.removeEventListener('wiki-connection-changed', invalidate);
      window.removeEventListener('wiki-data-changed', invalidate);
    };
  }, []);

  useEffect((): (() => void) => {
    const requestGeneration = ++generation.current;
    let cancelled = false;
    if (visible && scope && stateRevision) {
      void loadOntologyGlossary(scope, {
        document,
        entity_id: entityId,
        expected_state_revision: stateRevision,
        limit: 10,
      }).then((result: OntologyOutcome<OntologyGlossaryCard>): void => {
        if (cancelled || generation.current !== requestGeneration) return;
        if (!result.ok && invalidatesScope(result.error)) {
          invalidateScope();
          return;
        }
        setState({
          key,
          card: result.ok ? result.data : null,
          error: result.ok ? null : result.error,
        });
      });
    }
    return (): void => {
      cancelled = true;
    };
  }, [visible, scope, document, entityId, stateRevision, key]);

  const current = visible && state?.key === key ? state : null;
  return {
    visible,
    loading: visible && current === null,
    card: current?.card ?? null,
    error: current?.error ?? null,
  };
}
