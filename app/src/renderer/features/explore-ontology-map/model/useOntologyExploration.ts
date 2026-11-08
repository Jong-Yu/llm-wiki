import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useReadQueries } from '@renderer/shared/lib/readQueries';
import type { QueryCacheNotifyEvent } from '@tanstack/react-query';
import type {
  OntologyMapConcept,
  OntologyMapEdge,
  OntologyMapEndpoint,
  OntologyMapSourceAnchor,
  OntologyNeighborPage,
  OntologySearchPage,
} from '@contracts/ontologyExploration.contract';
import { searchOntology } from '../api/ontologyExploration.api';
import {
  OntologyQueryError,
  ontologySearchOptions,
  queryOntologyNeighbors,
} from '../api/ontologyExploration.queries';
import {
  invalidatesScope,
  readOntologyScope,
  validateOntologyScope,
} from '../api/ontologyMap.api';
import { applyExplorationSeed } from './explorationSeeds';
import { ontologyQualifications } from './ontologyQualifications';
import { conceptKey, predicateText, valueObject } from './buildOntologyGraph';
import { sourceAnchorLabel } from './sourceAnchors';
import type {
  MapConcept,
  MapAssertion,
  MapEdge,
  OntologyGraph,
  OntologyCanvasGraph,
  OntologyFailure,
  OntologyScope,
} from './ontologyMap.types';

export type ExplorationSeed = {
  concept: OntologyMapConcept;
  concepts: OntologyMapConcept[];
  anchors: OntologyMapSourceAnchor[];
  edges: OntologyMapEdge[];
  cursor: string | null;
  total: number;
  incomplete: boolean;
  coverage?: OntologyNeighborPage['coverage'];
  stale: boolean;
  /** 관계를 읽을 때 관측한 전체 검색 색인 기준이며 이웃 cursor의 문서 해시와 구분합니다. */
  indexRevision: string | null;
};
export type OntologyExplorationModel = {
  scope: OntologyScope | null;
  page: OntologySearchPage | null;
  searching: boolean;
  error: OntologyFailure | null;
  seeds: ExplorationSeed[];
  busy: string[];
  graph: OntologyCanvasGraph;
  searchMore: () => void;
  refreshSearch: () => void;
  reload: () => void;
  add: (concept: OntologyMapConcept) => Promise<boolean>;
  move: (concept: OntologyMapConcept, fromKey: string) => Promise<boolean>;
  more: (seed: ExplorationSeed) => void;
  refresh: (seed: ExplorationSeed) => void;
  remove: (key: string) => void;
};

/** 의미 한정어는 짧은 지도 이름에도 남겨 가능·부정을 확정 주장으로 보이지 않게 합니다. */
export function explorationLabel(
  edge: Pick<
    OntologyMapEdge,
    'label' | 'polarity' | 'modality' | 'conditional'
  >,
): string {
  const flags = ontologyQualifications({
    polarity: edge.polarity,
    modality: edge.modality,
    condition: edge.conditional ? true : null,
  });
  return `${predicateText(edge.label)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
}

/** 가벼운 개체 투영을 지도 타입으로 바꾸며 문서·개체 식별자를 유지합니다. */
export function explorationConcept(
  concept: OntologyMapConcept,
  relationCount?: number,
): MapConcept {
  return {
    key: conceptKey(concept.document, concept.entity_id),
    document: concept.document,
    entity: { id: concept.entity_id, label: concept.name, type: concept.type },
    attributeCount: concept.attribute_count,
    ...(relationCount === undefined ? {} : { relationCount }),
  };
}

/** 원문 위치와 실제 개체 ID의 이름 공간을 분리해 같은 문자열도 합치지 않습니다. */
export function explorationEndpointKey(endpoint: OntologyMapEndpoint): string {
  return 'anchor_id' in endpoint
    ? JSON.stringify([endpoint.document, 'source_anchor', endpoint.anchor_id])
    : conceptKey(endpoint.document, endpoint.entity_id);
}

/** 전체 문서의 같은 판본에서 확인한 관계만 경량 지도의 상세 대상이 됩니다. */
export function matchesExplorationProjection(
  edge: OntologyMapEdge,
  assertion: MapAssertion,
): boolean {
  return (
    assertion.document === edge.document &&
    assertion.knowledge.stateRevision === edge.ref.state_revision &&
    assertion.knowledge.sourceRevision === edge.ref.source_revision &&
    (edge.claim_id !== null && assertion.claim !== null
      ? assertion.claim.claim_id === edge.claim_id
      : assertion.key ===
        JSON.stringify([edge.document, edge.collection, edge.collection_index]))
  );
}

/** 요약 위치를 인용으로 가장하지 않고 같은 관계의 정확한 끝점에서 원문 상세를 찾습니다. */
export function resolveExplorationAnchor(
  anchor: OntologyMapSourceAnchor,
  edges: OntologyMapEdge[],
  graph: OntologyGraph,
): MapConcept | undefined {
  const resolved = new Map<string, MapConcept>();
  for (const edge of edges) {
    if (
      edge.document !== anchor.document ||
      edge.ref.state_revision !== anchor.ref.state_revision ||
      edge.ref.source_revision !== anchor.source_revision
    )
      continue;
    for (const side of ['subject', 'object'] as const) {
      const endpoint = edge[side];
      if (
        !('anchor_id' in endpoint) ||
        endpoint.document !== anchor.document ||
        endpoint.anchor_id !== anchor.anchor_id
      )
        continue;
      for (const assertion of graph.assertions) {
        if (!matchesExplorationProjection(edge, assertion)) continue;
        const concept = graph.concepts.find(
          (item: MapConcept): boolean => item.key === assertion[side],
        );
        const value = valueObject(concept?.entity.anchor);
        if (
          concept &&
          value?.kind === 'source_anchor' &&
          value.document === anchor.document &&
          value.source_revision === anchor.source_revision &&
          value.start_line === anchor.start_line &&
          value.end_line === anchor.end_line &&
          value.occurrence === anchor.occurrence
        )
          resolved.set(concept.key, concept);
      }
    }
  }
  return resolved.size === 1 ? resolved.values().next().value : undefined;
}

/** 시작점별로 읽은 페이지를 보관해 중복 관계와 같은 이름의 타 문서 개체를 구분합니다. */
export function graphFromSeeds(seeds: ExplorationSeed[]): OntologyCanvasGraph {
  const concepts = new Map<string, MapConcept>();
  const edges = new Map<string, MapEdge>();
  for (const seed of seeds) {
    for (const concept of seed.concepts) {
      const item = explorationConcept(concept);
      concepts.set(item.key, item);
    }
    for (const anchor of seed.anchors ?? []) {
      const key = explorationEndpointKey(anchor);
      concepts.set(key, {
        key,
        document: anchor.document,
        entity: {
          id: key,
          label: sourceAnchorLabel({
            kind: 'source_anchor',
            start_line: anchor.start_line,
            end_line: anchor.end_line,
          }),
          type: '원문 근거',
        },
        sourceAnchor: anchor,
      });
    }
    for (const edge of seed.edges) {
      edges.set(edge.key, {
        key: edge.key,
        document: edge.document,
        subject: explorationEndpointKey(edge.subject),
        object: explorationEndpointKey(edge.object),
        label: explorationLabel(edge),
        origin:
          edge.collection === 'relation_candidates'
            ? 'candidate'
            : edge.origin === 'machine'
              ? 'machine'
              : 'expert',
        collection:
          edge.collection === 'relation_candidates'
            ? 'relation_candidates'
            : 'relations',
      });
    }
  }
  for (const seed of seeds) {
    const focus = explorationConcept(seed.concept, seed.total);
    concepts.set(focus.key, focus);
  }
  return { concepts: [...concepts.values()], assertions: [...edges.values()] };
}

/** 관계 페이지의 문서 해시를 전체 검색 해시로 비교하지 않고 관측 당시 검색 기준을 보관합니다. */
export function explorationSeedFromPage(
  concept: OntologyMapConcept,
  page: OntologyNeighborPage,
  previous: ExplorationSeed | null,
  searchIndex: string | null,
): ExplorationSeed | null {
  const current = page.concepts.find(
    (row: OntologyMapConcept): boolean =>
      row.entity_id === concept.entity_id && row.document === concept.document,
  );
  if (!current) return null;
  const conceptRows = new Map<string, OntologyMapConcept>();
  const edgeRows = new Map<string, OntologyMapEdge>();
  const anchorRows = new Map<string, OntologyMapSourceAnchor>();
  for (const row of [...(previous?.concepts ?? []), ...page.concepts])
    conceptRows.set(conceptKey(row.document, row.entity_id), row);
  for (const row of [...(previous?.edges ?? []), ...page.edges])
    edgeRows.set(row.key, row);
  for (const row of [...(previous?.anchors ?? []), ...(page.anchors ?? [])])
    anchorRows.set(explorationEndpointKey(row), row);
  return {
    concept: current,
    concepts: [...conceptRows.values()],
    anchors: [...anchorRows.values()],
    edges: [...edgeRows.values()],
    cursor: page.next_cursor,
    total: page.total,
    incomplete: !page.coverage.complete || page.coverage.truncated,
    coverage: page.coverage,
    stale: false,
    indexRevision: searchIndex,
  };
}

/** 실제 전체 검색 기준의 변경이나 명시적 판본 오류가 있을 때만 새로 읽기를 안내합니다. */
export function explorationSeedIsStale(
  seed: ExplorationSeed,
  searchIndex: string | null,
): boolean {
  return (
    seed.stale ||
    Boolean(
      searchIndex && seed.indexRevision && seed.indexRevision !== searchIndex,
    )
  );
}

/** 검색·관계 요청 수명을 나누고 권한 변경에는 보관된 지도까지 즉시 지웁니다. */
export function useOntologyExploration(
  text: string,
  kind: 'all' | 'concept' | 'document',
  active: boolean,
  documentFilter: string | null = null,
): OntologyExplorationModel {
  const client = useQueryClient();
  const { cache: workspaceCache } = useReadQueries();
  const [scope, setScope] = useState<OntologyScope | null>(null);
  const [currentIndex, setCurrentIndex] = useState<string | null>(null);
  const [seeds, setSeeds] = useState<ExplorationSeed[]>([]);
  const [error, setError] = useState<OntologyFailure | null>(null);
  const criteria = JSON.stringify([text, kind, documentFilter]);
  const [errorCriteria, setErrorCriteria] = useState(criteria);
  // 새 검색의 첫 렌더에 이전 검색·관계 오류를 섞지 않습니다.
  if (errorCriteria !== criteria) {
    setErrorCriteria(criteria);
    setError(null);
  }
  const [busy, setBusy] = useState<string[]>([]);
  const alive = useRef(true);
  const epoch = useRef(0);
  const loading = useRef(new Set<string>());
  const documentBasis = useRef(new Map<string, string>());
  const movementGeneration = useRef(0);
  const seedGeneration = useRef(new Map<string, number>());
  const wasActive = useRef(active);
  const search = useInfiniteQuery({
    ...ontologySearchOptions(
      scope,
      {
        text,
        kind: documentFilter ? 'concept' : text ? kind : 'document',
        ...(documentFilter ? { document: documentFilter } : {}),
        limit: !text && !documentFilter ? 5 : 20,
      },
      setCurrentIndex,
    ),
    enabled: Boolean(scope && active),
  });
  const pages = search.data?.pages;
  // 최신 서버 관측을 별도로 유지해 과거 검색 캐시가 시작점의 stale 표시를 되돌리지 않습니다.
  const visibleSeeds = seeds.map((seed: ExplorationSeed): ExplorationSeed =>
    explorationSeedIsStale(seed, currentIndex)
      ? { ...seed, stale: true }
      : seed,
  );
  const page = useMemo((): OntologySearchPage | null => {
    const last = pages?.at(-1);
    return last && pages
      ? {
          ...last,
          items: pages.flatMap(
            (item: OntologySearchPage): OntologySearchPage['items'] =>
              item.items,
          ),
        }
      : null;
  }, [pages]);
  const graph = useMemo(
    (): OntologyCanvasGraph => graphFromSeeds(seeds),
    [seeds],
  );

  /** 범위 변경 뒤 이전 응답·선택 개념을 새 공간에 남기지 않습니다. */
  const clearScope = useCallback(
    (failure: OntologyFailure): void => {
      epoch.current += 1;
      client.clear();
      loading.current.clear();
      documentBasis.current.clear();
      seedGeneration.current.clear();
      setBusy([]);
      setScope(null);
      setCurrentIndex(null);
      setSeeds([]);
      setError(failure);
    },
    [client],
  );
  /** 오류가 권한 경계를 바꾸지 않으면 이미 읽은 지도는 보존합니다. */
  const fail = useCallback(
    (failure: OntologyFailure): void => {
      if (invalidatesScope(failure)) clearScope(failure);
      else setError(failure);
    },
    [clearScope],
  );
  /** 현재 연결을 다시 읽는 동작은 저장이나 자동 재분석을 실행하지 않습니다. */
  function reload(): void {
    const request = ++epoch.current;
    client.clear();
    loading.current.clear();
    documentBasis.current.clear();
    seedGeneration.current.clear();
    setBusy([]);
    setSeeds([]);
    setScope(null);
    setCurrentIndex(null);
    setError(null);
    void readOntologyScope().then(
      (result: Awaited<ReturnType<typeof readOntologyScope>>): void => {
        if (!alive.current || request !== epoch.current) return;
        if (result.ok) setScope({ ...result.data });
        else {
          setScope(null);
          setError(result.error);
        }
      },
    );
  }
  const start = useEffectEvent((): void => {
    const request = ++epoch.current;
    void readOntologyScope().then(
      (result: Awaited<ReturnType<typeof readOntologyScope>>): void => {
        if (!alive.current || request !== epoch.current) return;
        if (result.ok) setScope(result.data);
        else {
          setError(result.error);
        }
      },
    );
  });
  useEffect((): (() => void) => {
    alive.current = true;
    start();
    return (): void => {
      alive.current = false;
      epoch.current += 1;
    };
  }, []);

  /** 검색·관계 중 어느 쪽이든 권한 오류가 나면 외부 조회 저장소의 알림에서 함께 폐기합니다. */
  useEffect(
    (): (() => void) =>
      client.getQueryCache().subscribe((event: QueryCacheNotifyEvent): void => {
        const failure = event.query.state.error;
        if (
          event.type === 'updated' &&
          event.action.type === 'error' &&
          failure instanceof OntologyQueryError &&
          invalidatesScope(failure.failure)
        )
          workspaceCache.deny(failure.failure);
      }),
    [client, workspaceCache],
  );
  useEffect(
    (): (() => void) =>
      workspaceCache.subscribe((): void => {
        const failure = workspaceCache.getSnapshot().failure;
        if (failure) clearScope(failure);
      }),
    [workspaceCache, clearScope],
  );

  // 연결 전환은 즉시, 보관 화면의 재진입은 서버 범위를 재확인합니다.
  const checkScope = useEffectEvent((refresh: boolean): void => {
    if (!scope) return;
    const basis = epoch.current;
    void validateOntologyScope(scope).then(
      (result: Awaited<ReturnType<typeof validateOntologyScope>>): void => {
        if (!alive.current || basis !== epoch.current) return;
        if (!result.ok) {
          if (invalidatesScope(result.error)) clearScope(result.error);
          return;
        }
        if (refresh && active) {
          // 복귀·포커스에서는 짧은 TTL 안이라도 서버 상태를 다시 확인합니다.
          void client.invalidateQueries({ refetchType: 'none' });
          void search.refetch({ cancelRefetch: false });
        }
      },
    );
  });
  useEffect((): (() => void) => {
    const check = (): void => checkScope(true);
    const changed = (): void =>
      clearScope({
        code: 'scope_changed',
        message: '연결 범위가 변경되었습니다. 다시 불러와 주세요.',
      });
    window.addEventListener('wiki-connection-changed', changed);
    window.addEventListener('focus', check);
    return (): void => {
      window.removeEventListener('wiki-connection-changed', changed);
      window.removeEventListener('focus', check);
    };
  }, [clearScope]);
  useEffect((): void => {
    if (active && !wasActive.current) checkScope(true);
    wasActive.current = active;
  }, [active]);

  /** 한 시작점의 다음 페이지는 판본·cursor를 고정하고 중복 요청을 차단합니다. */
  async function readSeed(
    concept: OntologyMapConcept,
    previous: ExplorationSeed | null,
    movement: { fromKey: string; request: number } | null = null,
    searchIndex: string | null = currentIndex,
  ): Promise<boolean> {
    if (!scope || !concept.ref.state_revision) return false;
    const key = conceptKey(concept.document, concept.entity_id);
    if (loading.current.has(key)) return false;
    const basis = epoch.current;
    const revision = concept.ref.state_revision;
    documentBasis.current.set(concept.document, revision);
    const seedRequest = (seedGeneration.current.get(key) ?? 0) + 1;
    seedGeneration.current.set(key, seedRequest);
    loading.current.add(key);
    setBusy([...loading.current]);
    setError(null);
    const result = await queryOntologyNeighbors(client, scope, {
      document: concept.document,
      entity_id: concept.entity_id,
      expected_state_revision: concept.ref.state_revision,
      cursor: previous?.cursor ?? null,
      limit: 20,
    });
    if (
      !alive.current ||
      basis !== epoch.current ||
      seedGeneration.current.get(key) !== seedRequest
    )
      return false;
    loading.current.delete(key);
    setBusy([...loading.current]);
    if (
      documentBasis.current.get(concept.document) !== revision ||
      (movement && movement.request !== movementGeneration.current)
    )
      return false;
    if (!result.ok) {
      fail(result.error);
      if (result.error.code === 'catalog_changed')
        setSeeds((items: ExplorationSeed[]): ExplorationSeed[] =>
          items.map((seed: ExplorationSeed): ExplorationSeed =>
            seed.concept.document === concept.document
              ? { ...seed, stale: true }
              : seed,
          ),
        );
      return false;
    }
    const next = explorationSeedFromPage(
      concept,
      result.data,
      previous,
      searchIndex,
    );
    if (!next) {
      setError({
        code: 'concept_missing',
        message: '선택한 개념을 현재 판본에서 확인할 수 없습니다.',
      });
      return false;
    }
    setSeeds((items: ExplorationSeed[]): ExplorationSeed[] =>
      applyExplorationSeed(items, next, movement?.fromKey ?? null),
    );
    return true;
  }
  async function add(concept: OntologyMapConcept): Promise<boolean> {
    movementGeneration.current += 1;
    const key = conceptKey(concept.document, concept.entity_id);
    const previous = visibleSeeds.find(
      (seed: ExplorationSeed): boolean =>
        conceptKey(seed.concept.document, seed.concept.entity_id) === key,
    );
    if (
      previous &&
      previous.concept.ref.state_revision === concept.ref.state_revision &&
      !previous.stale
    )
      return true;
    return readSeed(concept, null);
  }
  /** 더블클릭은 주제를 늘리지 않고 현재 주제의 직접 관계로 중심을 옮깁니다. */
  async function move(
    concept: OntologyMapConcept,
    fromKey: string,
  ): Promise<boolean> {
    const request = ++movementGeneration.current;
    const key = conceptKey(concept.document, concept.entity_id);
    const existing = visibleSeeds.find(
      (seed: ExplorationSeed): boolean =>
        conceptKey(seed.concept.document, seed.concept.entity_id) === key,
    );
    if (existing) return !existing.stale ? true : readSeed(concept, null);
    if (
      !visibleSeeds.some(
        (seed: ExplorationSeed): boolean =>
          conceptKey(seed.concept.document, seed.concept.entity_id) === fromKey,
      )
    )
      return false;
    return readSeed(concept, null, { fromKey, request });
  }
  function more(seed: ExplorationSeed): void {
    if (seed.cursor && !seed.stale) void readSeed(seed.concept, seed);
  }
  /** 최신 문서 참조를 명시적으로 다시 읽으며 사라진 ID를 이름으로 대체하지 않습니다. */
  function refresh(seed: ExplorationSeed): void {
    movementGeneration.current += 1;
    if (!scope) return;
    const basis = epoch.current;
    const key = conceptKey(seed.concept.document, seed.concept.entity_id);
    const refreshGeneration = seedGeneration.current.get(key) ?? 0;
    void searchOntology(scope, {
      document: seed.concept.document,
      kind: 'document',
      limit: 1,
    }).then((result: Awaited<ReturnType<typeof searchOntology>>): void => {
      if (
        !alive.current ||
        basis !== epoch.current ||
        (seedGeneration.current.get(key) ?? 0) !== refreshGeneration
      )
        return;
      if (!result.ok) {
        fail(result.error);
        return;
      }
      const item = result.data.items.find(
        (row: (typeof result.data.items)[number]): boolean =>
          row.kind === 'document' && row.ref.document === seed.concept.document,
      );
      if (!item || item.kind !== 'document' || !item.ref.state_revision) {
        setError({
          code: 'concept_missing',
          message: '현재 문서의 탐색 기준을 확인하지 못했습니다.',
        });
        return;
      }
      // 같은 문서의 과거 판본 페이지를 새 판본과 섞지 않습니다.
      setCurrentIndex(result.data.index_revision);
      void readSeed(
        { ...seed.concept, ref: item.ref },
        null,
        null,
        result.data.index_revision,
      );
    });
  }
  function remove(key: string): void {
    movementGeneration.current += 1;
    seedGeneration.current.set(key, (seedGeneration.current.get(key) ?? 0) + 1);
    loading.current.delete(key);
    setBusy([...loading.current]);
    setSeeds((items: ExplorationSeed[]): ExplorationSeed[] =>
      items.filter(
        (seed: ExplorationSeed): boolean =>
          conceptKey(seed.concept.document, seed.concept.entity_id) !== key,
      ),
    );
  }
  return {
    scope,
    page,
    searching: search.isFetching || Boolean(!scope && !error),
    error:
      search.error instanceof OntologyQueryError ? search.error.failure : error,
    seeds: visibleSeeds,
    busy,
    graph,
    searchMore: (): void => {
      if (active && scope && search.hasNextPage && !search.isFetching)
        void search.fetchNextPage({ cancelRefetch: false });
    },
    refreshSearch: (): void => {
      if (active && scope) {
        void client.invalidateQueries({ refetchType: 'none' });
        void search.refetch({ cancelRefetch: false });
      }
    },
    reload,
    add,
    move,
    more,
    refresh,
    remove,
  };
}
