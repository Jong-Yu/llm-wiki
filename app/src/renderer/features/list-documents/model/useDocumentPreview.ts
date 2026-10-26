import { useEffect, useRef, useState } from 'react';
import { loadDocumentPreview } from '../api/documentPreview.api';
import type { DocumentPreviewOutcome } from '../api/documentPreview.api';
import type { DocumentListItem } from '@contracts/documents.contract';
import type { DocumentListScope } from '../api/documentList.api';

export type DocumentPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | DocumentPreviewOutcome;
export type DocumentPreviewInput = {
  item: DocumentListItem | null;
  scope: DocumentListScope | null;
  onScopeInvalidated: () => void;
};
export type DocumentPreviewModel = {
  state: DocumentPreviewState;
  retry: () => void;
};

/** 선택별로 마운트되며 교체/재조회/해제 후 도착한 예전 본문을 버립니다. */
export function useDocumentPreview({
  item,
  scope,
  onScopeInvalidated,
}: DocumentPreviewInput): DocumentPreviewModel {
  const [state, setState] = useState<DocumentPreviewState>(
    item && scope ? { status: 'loading' } : { status: 'idle' },
  );
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    if (item && scope)
      void loadDocumentPreview(item, scope).then(
        (result: DocumentPreviewOutcome): void => {
          if (!mounted.current || generation.current !== request) return;
          setState(result);
          if (result.status === 'error' && result.scopeInvalidated)
            onScopeInvalidated();
        },
      );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [item, scope, onScopeInvalidated]);

  /** 재조회 시작과 동시에 이전 본문을 숨기고 현재 선택의 최신 응답만 반영합니다. */
  function retry(): void {
    if (!item || !scope) return;
    const request = ++generation.current;
    setState({ status: 'loading' });
    void loadDocumentPreview(item, scope).then(
      (result: DocumentPreviewOutcome): void => {
        if (!mounted.current || generation.current !== request) return;
        setState(result);
        if (result.status === 'error' && result.scopeInvalidated)
          onScopeInvalidated();
      },
    );
  }
  return { state, retry };
}
