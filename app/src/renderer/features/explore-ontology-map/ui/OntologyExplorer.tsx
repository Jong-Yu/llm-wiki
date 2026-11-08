import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation } from 'react-router';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import type {
  OntologyMapConcept,
  OntologyMapEdge,
  OntologyMapSourceAnchor,
} from '@contracts/ontologyExploration.contract';
import { documentDisplayName } from '@renderer/domains/documents';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { Icon } from '@renderer/shared/ui/Icon';
import { documentEvidenceLink } from '@renderer/shared/lib/documentEvidence';
import { SkeletonText } from '@renderer/shared/ui/Skeleton';
import {
  invalidatesScope,
  reloadOntologyDocument,
} from '../api/ontologyMap.api';
import { buildOntologyGraph, conceptKey } from '../model/buildOntologyGraph';
import {
  explorationEndpointKey,
  matchesExplorationProjection as matchesProjection,
  resolveExplorationAnchor,
  useOntologyExploration,
} from '../model/useOntologyExploration';
import type { ExplorationSeed } from '../model/useOntologyExploration';
import type {
  MapAssertion,
  MapConcept,
  MapEdge,
  OntologyFailure,
} from '../model/ontologyMap.types';
import { OntologyAssertionDetails } from './OntologyAssertionDetails';
import { OntologyConceptDetails } from './OntologyConceptDetails';
import { OntologyGraphCanvas } from './OntologyGraphCanvas';
import type { OntologyGraphView } from './OntologyGraphCanvas';
import { OntologySearchPanel } from './OntologySearchPanel';
import { OntologyCoverageNotice } from './OntologyCoverageNotice';
import { OntologySelectionBar } from './OntologySelectionBar';
import { explorationTopicKey } from '../model/explorationSeeds';
import common from './OntologyMapWorkspace.module.scss';
import styles from './OntologyExplorer.module.scss';

type OntologyExplorerProps = { active: boolean };
type Selection =
  | { kind: 'concept'; concept: OntologyMapConcept }
  | { kind: 'anchor'; anchor: OntologyMapSourceAnchor }
  | { kind: 'attribute'; owner: OntologyMapConcept; assertionKey: string }
  | { kind: 'edge'; edge: OntologyMapEdge };
type DetailState = {
  key: string;
  knowledge: DocumentKnowledge | null;
  error: OntologyFailure | null;
  loading: boolean;
};
type ConceptMove = { previous: OntologyMapConcept; nextKey: string };
type RemovedConcept = {
  concept: OntologyMapConcept;
  remainsConnected: boolean;
};

/** 선택 문서의 기존 상세·편집·검토 주소로만 이동합니다. */
function taskUrl(
  document: string,
  assertion?: MapAssertion,
  mode?: 'edit' | 'review',
): string {
  const params = new URLSearchParams({
    path: document,
    document,
    view: 'detail',
    from: 'map',
  });
  if (assertion)
    params.set('claim', assertion.claim?.claim_id ?? assertion.key);
  if (mode) params.set('mode', mode);
  else if (assertion) params.set('tab', 'history');
  return `/ontology?${params.toString()}`;
}

/** 실제 검색과 개체별 부분 조회를 지도에 연결하고 전체 문서 상세는 선택한 뒤 읽습니다. */
export function OntologyExplorer({
  active,
}: OntologyExplorerProps): JSX.Element {
  const workspaceActive = useWorkspaceActivity();
  const location = useLocation();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'concept' | 'document'>('all');
  const [documentFilter, setDocumentFilter] = useState<string | null>(null);
  const model = useOntologyExploration(
    documentFilter ? '' : query,
    kind,
    active && workspaceActive,
    documentFilter,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [hasExplored, setHasExplored] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [moves, setMoves] = useState<ConceptMove[]>([]);
  const [removed, setRemoved] = useState<RemovedConcept | null>(null);
  const interactionTopic = useRef<string | null>(null);
  useEffect((): void => {
    interactionTopic.current = null;
  }, [model.scope]);
  const [camera, setCamera] = useState<{
    scope: typeof model.scope;
    memory: Map<string, OntologyGraphView>;
  }>(
    (): {
      scope: typeof model.scope;
      memory: Map<string, OntologyGraphView>;
    } => ({ scope: model.scope, memory: new Map() }),
  );
  if (camera.scope !== model.scope) {
    setCamera({ scope: model.scope, memory: new Map() });
    setSelection(null);
    setDetail(null);
    setFocusKey(null);
    setHasExplored(false);
    setMoves([]);
    setRemoved(null);
  }
  const memory = camera.memory;
  const detailGeneration = useRef(0);
  const focusRequest = useRef(0);
  const searchReturn = useRef<HTMLElement | null>(null);
  const detailReturn = useRef<HTMLElement | null>(null);
  const focus =
    model.graph.concepts.find(
      (concept: MapConcept): boolean => concept.key === focusKey,
    ) ??
    model.graph.concepts.find(
      (concept: MapConcept): boolean =>
        concept.key ===
        (model.seeds[0]
          ? conceptKey(
              model.seeds[0].concept.document,
              model.seeds[0].concept.entity_id,
            )
          : null),
    ) ??
    model.graph.concepts[0];
  const selectionReference =
    selection?.kind === 'concept'
      ? selection.concept
      : selection?.kind === 'anchor'
        ? selection.anchor
        : selection?.kind === 'attribute'
          ? selection.owner
          : selection?.edge;
  const selectionDocument = selectionReference?.document;
  const selectionRevision = selectionReference?.ref.state_revision;
  const selectionKey =
    selection?.kind === 'concept'
      ? conceptKey(selection.concept.document, selection.concept.entity_id)
      : selection?.kind === 'anchor'
        ? explorationEndpointKey(selection.anchor)
        : selection?.kind === 'attribute'
          ? selection.assertionKey
          : (selection?.edge.key ?? '');
  const selectionTitle =
    selection?.kind === 'anchor'
      ? '원문 근거'
      : selection?.kind === 'concept'
        ? '개념 정보'
        : selection?.kind === 'attribute'
          ? '속성 상세'
          : '관계 상세';
  const selectedSeed =
    selection?.kind === 'concept'
      ? model.seeds.find(
          (seed: ExplorationSeed): boolean =>
            conceptKey(seed.concept.document, seed.concept.entity_id) ===
            selectionKey,
        )
      : undefined;

  /** 상세는 투영 판본과 같은 전체 문서만 쓰며 늦은 응답을 다른 선택에 적용하지 않습니다. */
  const reloadScope = useEffectEvent((): void => model.reload());
  useEffect((): (() => void) => {
    const request = ++detailGeneration.current;
    const scope = model.scope;
    if (!scope || !selectionDocument || !selectionRevision)
      return (): void => {};
    void reloadOntologyDocument(selectionDocument, scope).then(
      (result: Awaited<ReturnType<typeof reloadOntologyDocument>>): void => {
        if (request !== detailGeneration.current) return;
        if (!result.ok) {
          setDetail({
            key: selectionKey,
            knowledge: null,
            error: result.error,
            loading: false,
          });
          if (invalidatesScope(result.error)) {
            setSelection(null);
            reloadScope();
          }
          return;
        }
        setDetail({
          key: selectionKey,
          knowledge:
            result.data.stateRevision === selectionRevision
              ? result.data
              : null,
          error:
            result.data.stateRevision === selectionRevision
              ? null
              : {
                  code: 'catalog_changed',
                  message:
                    '문서가 변경되었습니다. 이 개념의 연결을 새로 불러와 주세요.',
                },
          loading: false,
        });
      },
    );
    return (): void => {
      detailGeneration.current += 1;
    };
  }, [model.scope, selectionDocument, selectionRevision, selectionKey]);

  /** 추가가 성공해야 검색 패널을 닫고 기존 시작점과 같은 지도에 합칩니다. */
  function add(concept: OntologyMapConcept): void {
    const keepSearching = Boolean(focus) && searchOpen;
    const request = ++focusRequest.current;
    void model.add(concept).then((added: boolean): void => {
      if (!added || request !== focusRequest.current) return;
      setFocusKey(conceptKey(concept.document, concept.entity_id));
      setSearchOpen(keepSearching);
      setSelection(null);
      setMoves([]);
      setRemoved(null);
      interactionTopic.current = conceptKey(
        concept.document,
        concept.entity_id,
      );
    });
  }
  /** 읽은 이웃 개념도 실제 문서·개체 참조로만 다음 시작점이 됩니다. */
  function projection(concept: MapConcept): OntologyMapConcept | undefined {
    return model.seeds
      .flatMap((seed: ExplorationSeed): OntologyMapConcept[] => seed.concepts)
      .find(
        (row: OntologyMapConcept): boolean =>
          row.document === concept.document &&
          row.entity_id === concept.entity.id,
      );
  }
  function inspectConcept(concept: MapConcept): void {
    detailReturn.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (concept.sourceAnchor) {
      setSelection({ kind: 'anchor', anchor: concept.sourceAnchor });
      setSearchOpen(false);
      return;
    }
    const row = projection(concept);
    if (row) {
      interactionTopic.current = explorationTopicKey(
        model.seeds,
        concept.key,
        interactionTopic.current ?? focus?.key ?? null,
      );
      setSelection({ kind: 'concept', concept: row });
      setSearchOpen(false);
    }
  }
  function inspectEdge(edge: MapEdge): void {
    detailReturn.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const row = model.seeds
      .flatMap((seed: ExplorationSeed): OntologyMapEdge[] => seed.edges)
      .find((item: OntologyMapEdge): boolean => item.key === edge.key);
    if (row) {
      const owner =
        model.seeds.find(
          (seed: ExplorationSeed): boolean =>
            seed.edges.some(
              (item: OntologyMapEdge): boolean => item.key === row.key,
            ) &&
            conceptKey(seed.concept.document, seed.concept.entity_id) ===
              interactionTopic.current,
        ) ??
        model.seeds.find((seed: ExplorationSeed): boolean =>
          seed.edges.some(
            (item: OntologyMapEdge): boolean => item.key === row.key,
          ),
        );
      if (owner)
        interactionTopic.current = conceptKey(
          owner.concept.document,
          owner.concept.entity_id,
        );
      setSelection({ kind: 'edge', edge: row });
      setSearchOpen(false);
    }
  }
  function move(concept: MapConcept): void {
    const row = projection(concept);
    if (!row || !focus) return;
    const sourceKey = explorationTopicKey(
      model.seeds,
      concept.key,
      interactionTopic.current ?? focus.key,
    );
    const previous = model.seeds.find(
      (seed: ExplorationSeed): boolean =>
        conceptKey(seed.concept.document, seed.concept.entity_id) === sourceKey,
    )?.concept;
    if (!sourceKey || !previous) return;
    const request = ++focusRequest.current;
    void model.move(row, sourceKey).then((moved: boolean): void => {
      if (!moved || request !== focusRequest.current) return;
      setFocusKey(concept.key);
      setSelection(null);
      interactionTopic.current = concept.key;
      if (sourceKey !== concept.key)
        setMoves((items: ConceptMove[]): ConceptMove[] =>
          [...items, { previous, nextKey: concept.key }].slice(-30),
        );
      else setMoves([]);
    });
  }
  /** 관계를 따라 이동한 현재 갈래만 되돌리고 다른 함께 보기 개념은 유지합니다. */
  function previousConcept(): void {
    const last = moves.at(-1);
    if (!last) return;
    const request = ++focusRequest.current;
    void model
      .move(last.previous, last.nextKey)
      .then((moved: boolean): void => {
        if (!moved || request !== focusRequest.current) return;
        const key = conceptKey(last.previous.document, last.previous.entity_id);
        setFocusKey(key);
        interactionTopic.current = key;
        setSelection(null);
        setMoves((items: ConceptMove[]): ConceptMove[] => items.slice(0, -1));
      });
  }
  /** 띠에 보이는 개념은 추가하지 않고 현재 위치만 옮깁니다. */
  function focusConcept(key: string): void {
    const row = model.seeds.find(
      (seed: ExplorationSeed): boolean =>
        conceptKey(seed.concept.document, seed.concept.entity_id) === key,
    )?.concept;
    if (!row) return;
    const request = ++focusRequest.current;
    void model.move(row, key).then((moved: boolean): void => {
      if (!moved || request !== focusRequest.current) return;
      setFocusKey(key);
      interactionTopic.current = key;
      setSearchOpen(false);
      setSelection(null);
      setMoves([]);
    });
  }
  function openSearch(): void {
    searchReturn.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSearchOpen(true);
  }
  /** 닫힌 패널의 초점을 원래 지도 조작으로 돌려 키보드 탐색을 이어갑니다. */
  function closeSearch(): void {
    setSearchOpen(false);
    requestAnimationFrame((): void =>
      searchReturn.current?.focus({ preventScroll: true }),
    );
  }
  function closeDetail(): void {
    setSelection(null);
    requestAnimationFrame((): void =>
      detailReturn.current?.focus({ preventScroll: true }),
    );
  }
  function remove(key: string): void {
    const seed = model.seeds.find(
      (item: ExplorationSeed): boolean =>
        conceptKey(item.concept.document, item.concept.entity_id) === key,
    );
    if (!seed) return;
    focusRequest.current += 1;
    const remaining = model.seeds.filter(
      (item: ExplorationSeed): boolean => item !== seed,
    );
    setRemoved({
      concept: seed.concept,
      remainsConnected: remaining.some((item: ExplorationSeed): boolean =>
        item.concepts.some(
          (row: OntologyMapConcept): boolean =>
            conceptKey(row.document, row.entity_id) === key,
        ),
      ),
    });
    model.remove(key);
    setMoves([]);
    if (
      selection &&
      (selection.kind === 'concept' || selection.kind === 'attribute'
        ? !remaining.some((item: ExplorationSeed): boolean =>
            item.concepts.some(
              (row: OntologyMapConcept): boolean =>
                conceptKey(row.document, row.entity_id) ===
                (selection.kind === 'attribute'
                  ? conceptKey(
                      selection.owner.document,
                      selection.owner.entity_id,
                    )
                  : selectionKey),
            ),
          )
        : selection.kind === 'anchor'
          ? !remaining.some((item: ExplorationSeed): boolean =>
              item.anchors.some(
                (row: OntologyMapSourceAnchor): boolean =>
                  explorationEndpointKey(row) === selectionKey,
              ),
            )
          : !remaining.some((item: ExplorationSeed): boolean =>
              item.edges.some(
                (row: OntologyMapEdge): boolean =>
                  row.key === selection.edge.key,
              ),
            ))
    )
      setSelection(null);
    if (focus?.key === key) {
      const adjacent =
        remaining[Math.min(model.seeds.indexOf(seed), remaining.length - 1)];
      setFocusKey(
        adjacent
          ? conceptKey(adjacent.concept.document, adjacent.concept.entity_id)
          : null,
      );
    }
    if (interactionTopic.current === key) interactionTopic.current = null;
  }
  /** 함께 보기에서 뺀 개념은 원문을 바꾸지 않고 다시 읽어 되돌립니다. */
  function restoreConcept(): void {
    if (!removed) return;
    const request = ++focusRequest.current;
    void model.add(removed.concept).then((added: boolean): void => {
      if (!added || request !== focusRequest.current) return;
      setRemoved(null);
    });
  }
  function searchDocument(document: string | null): void {
    setHasExplored(true);
    setDocumentFilter(document);
  }

  const full =
    detail?.key === selectionKey && detail.knowledge
      ? buildOntologyGraph([detail.knowledge])
      : null;
  const loadedEdges = model.seeds.flatMap(
    (seed: ExplorationSeed): OntologyMapEdge[] => seed.edges,
  );
  const fullConcept =
    selection?.kind === 'concept'
      ? full?.concepts.find(
          (concept: MapConcept): boolean => concept.key === selectionKey,
        )
      : selection?.kind === 'anchor' && full
        ? resolveExplorationAnchor(selection.anchor, loadedEdges, full)
        : undefined;
  const loadedAssertions =
    full?.assertions.filter(
      (assertion: MapAssertion): boolean =>
        assertion.collection === 'attributes' ||
        loadedEdges.some((edge: OntologyMapEdge): boolean =>
          matchesProjection(edge, assertion),
        ),
    ) ?? [];
  const fullAssertion =
    selection?.kind === 'edge'
      ? full?.assertions.find((assertion: MapAssertion): boolean =>
          matchesProjection(selection.edge, assertion),
        )
      : selection?.kind === 'attribute'
        ? full?.assertions.find(
            (assertion: MapAssertion): boolean =>
              assertion.collection === 'attributes' &&
              assertion.key === selection.assertionKey &&
              assertion.subject ===
                conceptKey(selection.owner.document, selection.owner.entity_id),
          )
        : undefined;
  const evidenceLink =
    selectionDocument && detail?.knowledge
      ? documentEvidenceLink(
          selectionDocument,
          detail.knowledge.sourceRevision,
          fullAssertion?.value.evidence ??
            fullConcept?.entity.anchor ??
            fullConcept?.entity.evidence,
          location.pathname + location.search,
        )
      : { to: `/document?path=${encodeURIComponent(selectionDocument ?? '')}` };
  const shownDetail =
    detail?.key === selectionKey
      ? detail
      : selection
        ? { key: selectionKey, knowledge: null, error: null, loading: true }
        : null;
  const seedKeys = model.seeds.map((seed: ExplorationSeed): string =>
    conceptKey(seed.concept.document, seed.concept.entity_id),
  );
  const resultPanel = (
    <OntologySearchPanel
      query={query}
      input={input}
      kind={kind}
      page={model.page}
      searching={model.searching}
      busy={model.busy}
      seeds={model.seeds}
      onInput={setInput}
      onSubmit={(): void => {
        setHasExplored(true);
        const next = input.trim();
        if (documentFilter) {
          setDocumentFilter(null);
          setKind('all');
          setQuery(next);
        } else if (next === query) model.refreshSearch();
        else setQuery(next);
      }}
      onKind={setKind}
      onAdd={add}
      onMore={model.searchMore}
      onClose={focus ? closeSearch : undefined}
      documentFilter={documentFilter}
      showIntroduction={!hasExplored && model.seeds.length === 0}
      onDocument={searchDocument}
    />
  );

  return (
    <div className={`${common.root} ${styles.root}`}>
      {removed && (
        <div className={styles.removedNotice} role="status">
          <span>
            {removed.concept.name}을 함께 보기에서 뺐습니다.
            {removed.remainsConnected
              ? ' 다른 개념과 연결되어 지도에는 남아 있습니다.'
              : ''}
          </span>
          <button type="button" onClick={restoreConcept}>
            되돌리기
          </button>
          <button
            type="button"
            className={styles.close}
            aria-label="제외 안내 닫기"
            onClick={(): void => setRemoved(null)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {model.error && (
        <div className={styles.notice} role="alert">
          <span>
            {model.error.code === 'catalog_changed'
              ? '조회 기준이 바뀌었습니다. 연결을 새로 불러오거나 검색을 다시 해주세요.'
              : model.error.message}
          </span>
          <button type="button" onClick={model.reload}>
            다시 불러오기
          </button>
        </div>
      )}
      {focus ? (
        <div className={styles.mapArea} data-search-open={searchOpen}>
          {searchOpen && (
            <aside className={styles.searchAside}>{resultPanel}</aside>
          )}
          <div className={styles.canvas}>
            <OntologyGraphCanvas
              graph={model.graph}
              focus={focus}
              heading={
                <OntologySelectionBar
                  concepts={model.seeds.map(
                    (seed: ExplorationSeed): OntologyMapConcept => seed.concept,
                  )}
                  focusKey={focus.key}
                  onFocus={focusConcept}
                  onRemove={remove}
                />
              }
              selectedKey={
                selection?.kind === 'edge' ? selection.edge.key : null
              }
              selectedConceptKey={
                selection?.kind === 'attribute'
                  ? conceptKey(
                      selection.owner.document,
                      selection.owner.entity_id,
                    )
                  : selection && selection.kind !== 'edge'
                    ? selectionKey
                    : null
              }
              coveredRight={selection ? 360 : 0}
              onSelectAssertion={inspectEdge}
              onSelectConcept={inspectConcept}
              onMoveConcept={move}
              onClearSelection={(): void => setSelection(null)}
              memory={memory}
              exploration={{
                seeds: seedKeys,
                onSearch: openSearch,
                onPrevious: previousConcept,
                previousName: moves.at(-1)?.previous.name,
              }}
            />
          </div>
          {selection && (
            <aside className={styles.detail} aria-label={selectionTitle}>
              <header className={styles.panelHeading}>
                <h2>{selectionTitle}</h2>
                <button
                  type="button"
                  className={styles.close}
                  aria-label="상세 닫기"
                  onClick={closeDetail}
                >
                  <Icon name="x" size={16} />
                </button>
              </header>
              <div className={styles.detailBody}>
                {selection.kind === 'attribute' && (
                  <button
                    type="button"
                    onClick={(): void =>
                      setSelection({
                        kind: 'concept',
                        concept: selection.owner,
                      })
                    }
                  >
                    개념 정보로 돌아가기
                  </button>
                )}
                {selection.kind === 'concept' && (
                  <div className={styles.loadMore}>
                    <strong>선택한 개념의 지도 연결</strong>
                    {selectedSeed ? (
                      <>
                        <span>
                          조회 가능한 관계 {selectedSeed.edges.length} /{' '}
                          {selectedSeed.total}개 · 속성{' '}
                          {selectedSeed.concept.attribute_count}개
                        </span>
                        {selectedSeed.stale ||
                        shownDetail?.error?.code === 'catalog_changed' ? (
                          <button
                            type="button"
                            onClick={(): void => {
                              setSelection(null);
                              model.refresh(selectedSeed);
                            }}
                          >
                            이 개념의 연결 새로 불러오기
                          </button>
                        ) : (
                          selectedSeed.cursor && (
                            <button
                              type="button"
                              disabled={model.busy.includes(selectionKey)}
                              onClick={(): void => model.more(selectedSeed)}
                            >
                              {model.busy.includes(selectionKey)
                                ? '불러오는 중'
                                : `연결 ${Math.min(20, selectedSeed.total - selectedSeed.edges.length)}개 더 보기`}
                            </button>
                          )
                        )}
                        {selectedSeed.coverage && (
                          <OntologyCoverageNotice
                            coverage={selectedSeed.coverage}
                            scope="이 문서의 지도 조회"
                          />
                        )}
                      </>
                    ) : (
                      <>
                        <span>이웃으로 표시한 개념입니다.</span>
                        <button
                          type="button"
                          disabled={model.busy.includes(selectionKey)}
                          onClick={(): void => add(selection.concept)}
                        >
                          이 개념의 연결 불러오기
                        </button>
                      </>
                    )}
                  </div>
                )}
                {shownDetail?.loading && (
                  <div
                    role="status"
                    aria-label="선택한 항목의 상세 불러오는 중"
                  >
                    <SkeletonText lines={5} />
                  </div>
                )}
                {shownDetail?.error && (
                  <p role="alert">{shownDetail.error.message}</p>
                )}
                {fullConcept && (
                  <OntologyConceptDetails
                    concept={fullConcept}
                    assertions={loadedAssertions}
                    knowledge={detail?.knowledge ?? null}
                    scope={model.scope}
                    active={active && workspaceActive}
                    onScopeInvalidated={(): void => {
                      setSelection(null);
                      setDetail(null);
                      model.reload();
                    }}
                    onSelectAssertion={(assertion: MapAssertion): void => {
                      if (
                        assertion.collection === 'attributes' &&
                        selection.kind === 'concept'
                      ) {
                        setSelection({
                          kind: 'attribute',
                          owner: selection.concept,
                          assertionKey: assertion.key,
                        });
                        setSearchOpen(false);
                        return;
                      }
                      const edge = loadedEdges.find(
                        (item: OntologyMapEdge): boolean =>
                          matchesProjection(item, assertion),
                      );
                      if (edge) {
                        setSelection({ kind: 'edge', edge });
                        setSearchOpen(false);
                      }
                    }}
                    onMove={
                      selection.kind === 'anchor' ||
                      fullConcept.key === focus.key
                        ? undefined
                        : move
                    }
                  />
                )}
                {fullAssertion && (
                  <>
                    <OntologyAssertionDetails assertion={fullAssertion} />
                    <div className={styles.detailActions}>
                      <Link to={taskUrl(fullAssertion.document, fullAssertion)}>
                        문서별 지도에서 검토 이력 보기
                      </Link>
                      {model.scope?.permissions.includes('ontology_review') && (
                        <>
                          <Link
                            to={taskUrl(
                              fullAssertion.document,
                              fullAssertion,
                              'edit',
                            )}
                          >
                            원문 근거 정정
                          </Link>
                          <Link
                            to={taskUrl(
                              fullAssertion.document,
                              fullAssertion,
                              'review',
                            )}
                          >
                            검토하기
                          </Link>
                        </>
                      )}
                    </div>
                  </>
                )}
                {!shownDetail?.loading &&
                  !shownDetail?.error &&
                  selection.kind === 'anchor' &&
                  !fullConcept && (
                    <p role="alert">
                      이 원문 연결의 현재 근거를 확인하지 못했습니다. 연결을
                      새로 불러온 뒤 다시 선택해 주세요.
                    </p>
                  )}
                {!shownDetail?.loading &&
                  !shownDetail?.error &&
                  (selection.kind === 'edge' ||
                    selection.kind === 'attribute') &&
                  !fullAssertion && (
                    <p>
                      이 {selection.kind === 'attribute' ? '속성' : '관계'}의
                      현재 상세 대상을 확인하지 못했습니다. 문서에서 전체 근거를
                      확인해 주세요.
                    </p>
                  )}
                {selectionDocument && (
                  <div className={styles.detailActions}>
                    <Link {...evidenceLink}>
                      <Icon name="file-text" size={14} />
                      {documentDisplayName(selectionDocument)}
                    </Link>
                    <Link
                      to={`/ontology?path=${encodeURIComponent(selectionDocument)}&from=map`}
                    >
                      문서의 전체 온톨로지 보기
                    </Link>
                    {model.scope?.permissions.includes('ontology_review') && (
                      <Link
                        to={`/ontology?path=${encodeURIComponent(selectionDocument)}&document=${encodeURIComponent(selectionDocument)}&view=relation-new`}
                      >
                        관계 추가
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      ) : (
        <div className={styles.start}>{resultPanel}</div>
      )}
    </div>
  );
}
