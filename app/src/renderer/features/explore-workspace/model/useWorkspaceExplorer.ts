import { useEffect, useRef, useState } from 'react';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { WorkspaceResponse } from '@contracts/workspace.contract';
import {
  loadExplorerCatalog,
  loadExplorerClaims,
  queryExplorer,
} from '../api/workspaceExplorer.api';
import type {
  ExplorerCatalog,
  ExplorerError,
  ExplorerOutcome,
  ClaimOption,
  ExplorerReviewSelection,
  ExplorerScope,
} from '../api/workspaceExplorer.api';
import type { ExplorerMode, ExplorerValues } from './explorerForm.schema';
import type { ExplorerRow } from './explorerPresentation';
import { object, stringField } from './explorerPresentation';

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; catalog: ExplorerCatalog }
  | { status: 'error'; error: ExplorerError };
export type ExplorerResultState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; response: WorkspaceResponse }
  | { status: 'error'; error: ExplorerError };
export type OnExplorerReview = (
  selection: ExplorerReviewSelection,
  connectionId: string,
  scope: ExplorerScope,
) => void;
type QueryMemory = {
  values: ExplorerValues;
  target?: KnowledgeValue;
  cursors: (string | null)[];
};
export type WorkspaceExplorerModel = {
  catalog: CatalogState;
  result: ExplorerResultState;
  claims: ClaimOption[];
  busy: boolean;
  claimError: string | null;
  pageNumber: number;
  canPrevious: boolean;
  reload: () => void;
  nextCatalog: () => void;
  query: (values: ExplorerValues) => void;
  queryTarget: (target: KnowledgeValue) => void;
  next: () => void;
  previous: () => void;
  loadClaims: (documents: string[]) => Promise<void>;
  review: (row: ExplorerRow, onReview: OnExplorerReview) => Promise<void>;
};

/** 명시한 범위의 읽기만 실행하며 권한/선택 변경 뒤 늦은 결과를 버립니다. */
export function useWorkspaceExplorer(
  mode: ExplorerMode,
): WorkspaceExplorerModel {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' });
  const [result, setResult] = useState<ExplorerResultState>({ status: 'idle' });
  const [claims, setClaims] = useState<ClaimOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [memory, setMemory] = useState<QueryMemory | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const catalogGeneration = useRef(0);
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++catalogGeneration.current;
    void loadExplorerCatalog(null).then(
      (value: ExplorerOutcome<ExplorerCatalog>): void => {
        if (mounted.current && request === catalogGeneration.current)
          setCatalog(
            value.ok
              ? { status: 'ready', catalog: value.data }
              : { status: 'error', error: value.error },
          );
      },
    );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
      catalogGeneration.current += 1;
    };
  }, []);

  /** 접근 범위가 무효화되면 목록/선택 주장과 결과를 함께 숨깁니다. */
  function invalidate(error: ExplorerError): void {
    if (
      error.status === 401 ||
      error.status === 403 ||
      [
        'scope_changed',
        'selection_required',
        'connection_changed',
        'subject_changed',
      ].includes(error.code)
    ) {
      setCatalog({ status: 'error', error });
      // 읽기 거부 뒤 이전 결과/대기 응답을 현재 자료로 다시 공개하지 않습니다.
      generation.current += 1;
      catalogGeneration.current += 1;
      setResult({ status: 'error', error });
      setClaims([]);
      setMemory(null);
      setBusy(false);
    }
  }
  /** 명시적 새로고침은 이전 범위를 버리고 실제 첫 목록을 읽습니다. */
  function reload(): void {
    const request = ++catalogGeneration.current;
    generation.current += 1;
    setCatalog({ status: 'loading' });
    setResult({ status: 'idle' });
    setClaims([]);
    setClaimError(null);
    setMemory(null);
    setBusy(false);
    void loadExplorerCatalog(null).then(
      (value: ExplorerOutcome<ExplorerCatalog>): void => {
        if (mounted.current && request === catalogGeneration.current)
          setCatalog(
            value.ok
              ? { status: 'ready', catalog: value.data }
              : { status: 'error', error: value.error },
          );
      },
    );
  }
  /** 사용자가 요청할 때만 다음 실제 목록 페이지를 읽고 이전 선택 후보도 보존합니다. */
  function nextCatalog(): void {
    if (catalog.status !== 'ready' || !catalog.catalog.nextCursor || busy)
      return;
    const before = catalog.catalog;
    const request = ++catalogGeneration.current;
    setBusy(true);
    void loadExplorerCatalog(before.nextCursor, before.scope).then(
      (value: ExplorerOutcome<ExplorerCatalog>): void => {
        if (!mounted.current || request !== catalogGeneration.current) return;
        setBusy(false);
        if (!value.ok) {
          invalidate(value.error);
          setClaimError(value.error.message);
          return;
        }
        const items = [
          ...before.items,
          ...value.data.items.filter(
            (item: ExplorerCatalog['items'][number]): boolean =>
              !before.items.some(
                (prior: ExplorerCatalog['items'][number]): boolean =>
                  prior.kind === item.kind &&
                  (prior.kind === 'wiki' && item.kind === 'wiki'
                    ? prior.document === item.document
                    : prior.kind === 'source' &&
                      item.kind === 'source' &&
                      prior.sourceId === item.sourceId),
              ),
          ),
        ];
        setCatalog({ status: 'ready', catalog: { ...value.data, items } });
      },
    );
  }
  /** 요청 값과 cursor를 고정해 페이지 이동이 선택 범위를 바꾸지 않게 합니다. */
  function run(next: QueryMemory): void {
    if (catalog.status !== 'ready') return;
    const request = ++generation.current;
    setResult({ status: 'loading' });
    setMemory(next);
    void queryExplorer(
      mode,
      next.values,
      catalog.catalog,
      claims,
      next.cursors.at(-1) || null,
      next.target,
    ).then((value: ExplorerOutcome<WorkspaceResponse>): void => {
      if (!mounted.current || request !== generation.current) return;
      if (value.ok) setResult({ status: 'ready', response: value.data });
      else {
        setResult({ status: 'error', error: value.error });
        invalidate(value.error);
      }
    });
  }
  /** 새 검색은 첫 페이지에서 시작합니다. */
  function query(values: ExplorerValues): void {
    run({ values: structuredClone(values), cursors: [null] });
  }
  /** 발견 API가 반환한 target_ref만 상세 조회 입력으로 전달합니다. */
  function queryTarget(target: KnowledgeValue): void {
    if (memory) run({ values: memory.values, cursors: [null], target });
  }
  /** 다음 cursor는 현재 응답이 제공한 값만 사용합니다. */
  function next(): void {
    if (result.status === 'ready' && memory) {
      const cursor = stringField(result.response.data, 'next_cursor');
      if (cursor && result.response.data.requires_refresh !== true)
        run({ ...memory, cursors: [...memory.cursors, cursor] });
    }
  }
  /** 이전 페이지도 고정 범위에서 다시 읽습니다. */
  function previous(): void {
    if (memory && memory.cursors.length > 1)
      run({ ...memory, cursors: memory.cursors.slice(0, -1) });
  }
  /** 질문에서 선택할 주장은 각 문서의 현재 state와 함께 다시 읽습니다. */
  async function loadClaims(documents: string[]): Promise<void> {
    if (catalog.status !== 'ready') return;
    if (documents.length === 0) {
      setClaimError(
        '주장을 확인할 위키·필수 문서를 먼저 선택해 주세요. 원본만으로도 질문 근거를 준비할 수 있습니다.',
      );
      return;
    }
    setBusy(true);
    setClaimError(null);
    const request = ++generation.current;
    const response = await loadExplorerClaims(documents, catalog.catalog.scope);
    if (!mounted.current || request !== generation.current) return;
    setBusy(false);
    if (response.ok) setClaims(response.data);
    else {
      setClaimError(response.error.message);
      invalidate(response.error);
    }
  }
  /** 검토 버튼은 오래된 목록의 claim을 그대로 쓰지 않고 현재 원문 기준으로 재확인합니다. */
  async function review(
    row: ExplorerRow,
    onReview: OnExplorerReview,
  ): Promise<void> {
    if (catalog.status !== 'ready' || !row.document) return;
    const claim = object(row.value.claim);
    const id = claim ? stringField(claim, 'claim_id') : null;
    if (!id) return;
    setBusy(true);
    setClaimError(null);
    const request = ++generation.current;
    const response = await loadExplorerClaims(
      [row.document],
      catalog.catalog.scope,
    );
    if (!mounted.current || request !== generation.current) return;
    setBusy(false);
    if (!response.ok) {
      setClaimError(response.error.message);
      invalidate(response.error);
      return;
    }
    const current = response.data.find(
      (item: ClaimOption): boolean =>
        item.claimId === id && item.document === row.document,
    );
    if (!current) {
      setClaimError(
        '선택한 주장이 변경되었습니다. 검토함을 다시 조회해 주세요.',
      );
      return;
    }
    onReview(
      {
        document: current.document,
        claimId: current.claimId,
        stateRevision: current.stateRevision,
        collection: current.collection,
        value: current.value,
        reviewedValue: current.reviewedValue,
        ambiguous: current.ambiguous,
        title: current.label,
      },
      catalog.catalog.scope.connectionId,
      catalog.catalog.scope,
    );
  }
  return {
    catalog,
    result,
    claims,
    busy,
    claimError,
    pageNumber: memory?.cursors.length || 1,
    canPrevious: (memory?.cursors.length || 1) > 1,
    reload,
    nextCatalog,
    query,
    queryTarget,
    next,
    previous,
    loadClaims,
    review,
  };
}
