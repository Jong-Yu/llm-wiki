import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  invalidatesScope,
  loadOntologyPage,
  reloadOntologyDocument,
  validateOntologyScope,
} from '../api/ontologyMap.api';
import type {
  OntologyFailure,
  OntologyOutcome,
  OntologySnapshot,
} from './ontologyMap.types';

export type OntologyMapModel = {
  snapshot: OntologySnapshot | null;
  error: OntologyFailure | null;
  loading: boolean;
  reload: () => void;
  refreshDocument: (document: string) => Promise<DocumentKnowledge | null>;
  loadMore: () => void;
  invalidate: () => void;
};

/** 일시적 조회 실패에는 마지막 그래프를 남기고 권한 변경에는 이전 자료를 숨깁니다. */
export function useOntologyMap(
  onScopeInvalidated: () => void,
  documentPath: string | null = null,
): OntologyMapModel {
  const [loadedPath, setLoadedPath] = useState(documentPath);
  const [snapshot, setSnapshot] = useState<OntologySnapshot | null>(null);
  const [error, setError] = useState<OntologyFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const active = useRef(false);
  const inFlight = useRef(false);
  const invalidationCallback = useRef(onScopeInvalidated);
  useEffect((): void => {
    invalidationCallback.current = onScopeInvalidated;
  }, [onScopeInvalidated]);

  /** 늦은 요청은 새 페이지 수명에 결과를 섞지 않습니다. */
  function apply(
    result: OntologyOutcome<OntologySnapshot>,
    request: number,
    append: boolean,
  ): void {
    if (!active.current || request !== generation.current) return;
    inFlight.current = false;
    setLoading(false);
    setLoadedPath(documentPath);
    if (!result.ok) {
      setError(result.error);
      if (loadedPath !== documentPath) setSnapshot(null);
      if (invalidatesScope(result.error)) {
        setSnapshot(null);
        invalidationCallback.current();
      }
      return;
    }
    setError(null);
    setSnapshot((previous: OntologySnapshot | null): OntologySnapshot => {
      if (!append || !previous) return result.data;
      const documents = new Map(
        previous.documents.map(
          (
            item: (typeof previous.documents)[number],
          ): [string, typeof item] => [item.document, item],
        ),
      );
      for (const item of result.data.documents)
        documents.set(item.document, item);
      return {
        ...result.data,
        documents: [...documents.values()],
        skipped: [...previous.skipped, ...result.data.skipped],
      };
    });
  }

  const beginLoad = useEffectEvent((): void => {
    active.current = true;
    inFlight.current = true;
    const request = ++generation.current;
    void loadOntologyPage(null, undefined, documentPath).then(
      (result: OntologyOutcome<OntologySnapshot>): void =>
        apply(result, request, false),
    );
  });
  useEffect((): (() => void) => {
    beginLoad();
    return (): void => {
      active.current = false;
      generation.current += 1;
    };
  }, [documentPath]);

  // 다른 창/설정에서 바뀐 범위는 다시 활성화될 때 확인하고 이전 자료 수명을 끝냅니다.
  useEffect((): (() => void) => {
    const scope = snapshot?.scope;
    let listening = true;
    const checkScope = (): void => {
      if (!scope || document.visibilityState === 'hidden') return;
      void validateOntologyScope(scope).then(
        (result: OntologyOutcome<null>): void => {
          if (
            !listening ||
            !active.current ||
            result.ok ||
            !invalidatesScope(result.error)
          )
            return;
          generation.current += 1;
          inFlight.current = false;
          setLoading(false);
          setError(result.error);
          setSnapshot(null);
          invalidationCallback.current();
        },
      );
    };
    window.addEventListener('focus', checkScope);
    document.addEventListener('visibilitychange', checkScope);
    return (): void => {
      listening = false;
      window.removeEventListener('focus', checkScope);
      document.removeEventListener('visibilitychange', checkScope);
    };
  }, [snapshot?.scope]);

  /** 최신 조회는 사용자가 요청하며 저장 재시도를 포함하지 않습니다. */
  function reload(): void {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    const request = ++generation.current;
    void loadOntologyPage(null, snapshot?.scope, documentPath).then(
      (result: OntologyOutcome<OntologySnapshot>): void =>
        apply(result, request, false),
    );
  }

  /** 저장 뒤에는 해당 문서를 갱신하여 이미 읽은 다른 페이지와 선택을 유지합니다. */
  function refreshDocument(
    document: string,
  ): Promise<DocumentKnowledge | null> {
    if (!snapshot) return Promise.resolve(null);
    // 이전 작업의 늦은 저장 응답은 새 단일 문서의 조회를 바꾸지 않습니다.
    if (documentPath && documentPath !== document) return Promise.resolve(null);
    // 저장 결과는 이전 조회보다 새롭기 때문에 진행 중 조회를 무효화합니다.
    const request = ++generation.current;
    inFlight.current = true;
    setLoading(true);
    // 범위 전환 중 저장되면 새 범위를 다시 읽어 판본과 문서 목록을 함께 확정합니다.
    if (loadedPath !== documentPath)
      return loadOntologyPage(null, snapshot.scope, documentPath).then(
        async (
          result: OntologyOutcome<OntologySnapshot>,
        ): Promise<DocumentKnowledge | null> => {
          if (!active.current || request !== generation.current) return null;
          if (!result.ok) {
            apply(result, request, false);
            return null;
          }
          let refreshed = result.data.documents.find(
            (entry: DocumentKnowledge): boolean => entry.document === document,
          );
          let next = result.data;
          // 첫 페이지 밖의 저장 대상도 기존 직접 조회 계약을 유지합니다.
          if (!refreshed) {
            const target = await reloadOntologyDocument(document, next.scope);
            if (!active.current || request !== generation.current) return null;
            if (!target.ok) {
              apply(target, request, false);
              return null;
            }
            refreshed = target.data;
            next = { ...next, documents: [...next.documents, refreshed] };
          }
          apply({ ok: true, data: next }, request, false);
          return refreshed;
        },
      );
    return reloadOntologyDocument(document, snapshot.scope).then(
      (
        result: OntologyOutcome<DocumentKnowledge>,
      ): DocumentKnowledge | null => {
        if (!active.current || request !== generation.current) return null;
        inFlight.current = false;
        setLoading(false);
        if (!result.ok) {
          setError(result.error);
          if (invalidatesScope(result.error)) {
            setSnapshot(null);
            invalidationCallback.current();
          }
          return null;
        }
        setError(null);
        setSnapshot(
          (previous: OntologySnapshot | null): OntologySnapshot | null =>
            previous
              ? {
                  ...previous,
                  documents: previous.documents.some(
                    (entry: DocumentKnowledge): boolean =>
                      entry.document === document,
                  )
                    ? previous.documents.map(
                        (entry: DocumentKnowledge): DocumentKnowledge =>
                          entry.document === document ? result.data : entry,
                      )
                    : [...previous.documents, result.data],
                }
              : null,
        );
        return result.data;
      },
    );
  }

  /** 다음 범위는 서버의 실제 cursor를 사용하고 기존 선택 그래프를 보존합니다. */
  function loadMore(): void {
    if (inFlight.current || !snapshot?.nextCursor) return;
    inFlight.current = true;
    setLoading(true);
    const request = ++generation.current;
    void loadOntologyPage(snapshot.nextCursor, snapshot.scope).then(
      (result: OntologyOutcome<OntologySnapshot>): void =>
        apply(result, request, true),
    );
  }

  /** 쓰기 도중 확인된 범위 변경도 조회 화면 전체에 반영합니다. */
  function invalidate(): void {
    generation.current += 1;
    inFlight.current = false;
    setLoading(false);
    setSnapshot(null);
    setError({
      code: 'scope_changed',
      message:
        '연결 또는 작업 공간이 변경되었습니다. 현재 범위에서 다시 불러와 주세요.',
    });
  }
  return {
    snapshot: loadedPath === documentPath ? snapshot : null,
    error: loadedPath === documentPath ? error : null,
    loading: loadedPath !== documentPath || loading,
    reload,
    refreshDocument,
    loadMore,
    invalidate,
  };
}
