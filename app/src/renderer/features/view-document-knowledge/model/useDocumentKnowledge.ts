import { useEffect, useRef, useState } from 'react';
import { loadDocumentKnowledge } from '../api/documentKnowledge.api';
import type {
  DocumentKnowledgeOutcome,
  KnowledgeScope,
} from '../api/documentKnowledge.api';

export type DocumentKnowledgeInput = {
  connectionId: string;
  document: string;
  scope: KnowledgeScope;
  onScopeInvalidated: () => void;
};
export type DocumentKnowledgeState =
  | { status: 'loading' }
  | DocumentKnowledgeOutcome;
type ScopedState = { key: string; state: DocumentKnowledgeState };
export type DocumentKnowledgeModel = {
  state: DocumentKnowledgeState;
  refresh: () => void;
  retry: () => void;
};

/** 문서·주체·관점별 응답 수명을 분리하고 선택이 바뀌면 이전 지식을 즉시 숨깁니다. */
export function useDocumentKnowledge({
  connectionId,
  document,
  scope,
  onScopeInvalidated,
}: DocumentKnowledgeInput): DocumentKnowledgeModel {
  const { userId, tenant, profileId, policyRevision, domain, viewpoint } =
    scope;
  const key = JSON.stringify([
    connectionId,
    document,
    userId,
    tenant,
    profileId,
    policyRevision,
    domain,
    viewpoint,
  ]);
  const [record, setRecord] = useState<ScopedState>({
    key,
    state: { status: 'loading' },
  });
  const generation = useRef(0);
  const mounted = useRef(false);
  const invalidate = useRef(onScopeInvalidated);
  useEffect((): void => {
    invalidate.current = onScopeInvalidated;
  }, [onScopeInvalidated]);
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    const expected: KnowledgeScope = {
      userId,
      tenant,
      profileId,
      policyRevision,
      domain,
      viewpoint,
    };
    void loadDocumentKnowledge(connectionId, document, expected).then(
      (state: DocumentKnowledgeOutcome): void => {
        if (!mounted.current || generation.current !== request) return;
        setRecord({ key, state });
        if (state.status === 'error' && state.scopeInvalidated)
          invalidate.current();
      },
    );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [
    connectionId,
    document,
    userId,
    tenant,
    profileId,
    policyRevision,
    domain,
    viewpoint,
    key,
  ]);

  /** 새 조회를 시작하면 이전 snapshot을 현재 완료 결과로 계속 표시하지 않습니다. */
  function refresh(): void {
    const request = ++generation.current;
    setRecord({ key, state: { status: 'loading' } });
    void loadDocumentKnowledge(connectionId, document, scope).then(
      (state: DocumentKnowledgeOutcome): void => {
        if (!mounted.current || generation.current !== request) return;
        setRecord({ key, state });
        if (state.status === 'error' && state.scopeInvalidated)
          invalidate.current();
      },
    );
  }
  return {
    state: record.key === key ? record.state : { status: 'loading' },
    refresh,
    retry: refresh,
  };
}
