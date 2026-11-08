import { useEffect, useState } from 'react';
import { loadCorrectionBasis, loadOntologyPage } from '../api/ontologyMap.api';
import type { CorrectionBasis } from './ontologyMap.types';
import { reviewAssertion } from './reviewTargets';

export type ClaimBasisState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; basis: CorrectionBasis };

/** 문서와 주장 ID로 현재 원문·판본 기준을 읽으며, 대상이 바뀌면 이전 응답을 버립니다. */
export function useClaimBasis(
  document: string,
  claimId: string,
): ClaimBasisState {
  const [loaded, setLoaded] = useState<{
    key: string;
    state: ClaimBasisState;
  } | null>(null);
  const key = JSON.stringify([document, claimId]);

  useEffect((): (() => void) => {
    let current = true;
    void (async (): Promise<void> => {
      const page = await loadOntologyPage(null, undefined, document);
      if (!current) return;
      if (!page.ok) {
        setLoaded({
          key,
          state: { phase: 'error', message: page.error.message },
        });
        return;
      }
      const knowledge = page.data.documents.find(
        (item: (typeof page.data.documents)[number]): boolean =>
          item.document === document,
      );
      const claim = [
        ...(knowledge?.currentClaims ?? knowledge?.claims ?? []),
      ].find(
        (item: { claim_id: string }): boolean => item.claim_id === claimId,
      );
      if (!knowledge || !claim) {
        setLoaded({ key, state: { phase: 'missing' } });
        return;
      }
      const basis = await loadCorrectionBasis(
        reviewAssertion(knowledge, claim),
        page.data.scope,
        'review',
      );
      if (!current) return;
      setLoaded({
        key,
        state: basis.ok
          ? { phase: 'ready', basis: basis.data }
          : { phase: 'error', message: basis.error.message },
      });
    })();
    return (): void => {
      current = false;
    };
  }, [document, claimId, key]);

  return loaded?.key === key ? loaded.state : { phase: 'loading' };
}
