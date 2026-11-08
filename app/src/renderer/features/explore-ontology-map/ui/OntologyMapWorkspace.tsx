import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@renderer/shared/ui/Button';
import { EmptyState } from '@renderer/shared/ui/PageNotice';
import { Tabs } from '@renderer/shared/ui/Tabs';
import type {
  DocumentKnowledge,
  KnowledgeClaim,
} from '@contracts/knowledge.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { invalidatesScope, loadCorrectionBasis } from '../api/ontologyMap.api';
import {
  ontologyWorkspaceRoute,
  ontologyWorkspaceView,
} from '../model/ontologyWorkspace';
import type {
  OntologyDraftKind,
  OntologyReviewDocument,
  OntologyReviewRow,
} from '../model/ontologyWorkspace';
import type {
  CorrectionBasis,
  CorrectionReceipt,
  MapAssertion,
  MapEdge,
  MapConcept,
  OntologyFailure,
  OntologyScope,
} from '../model/ontologyMap.types';
import { reviewAssertion } from '../model/reviewTargets';
import { useOntologyMap } from '../model/useOntologyMap';
import { OntologyMapLayout } from './OntologyMapLayout';
import { OntologyGraphCanvas } from './OntologyGraphCanvas';
import type { OntologyGraphView } from './OntologyGraphCanvas';
import { OntologyAssertionDetails } from './OntologyAssertionDetails';
import { OntologyConceptDetails } from './OntologyConceptDetails';
import { OntologyCorrectionPage } from './OntologyCorrectionPage';
import { OntologyRelationDocumentChoice } from './OntologyRelationDocumentChoice';
import { OntologyRelationPanel } from './OntologyRelationPanel';
import { OntologyReviewPage } from './OntologyReviewPage';
import { OntologyReviewHistory } from './OntologyReviewHistory';
import { ontologyTermLabel } from '../model/ontologyLabels';
import { OntologyCleanupPage } from './OntologyCleanupPage';
import styles from './OntologyMapWorkspace.module.scss';

type OntologyDraft = {
  key: string;
  kind: OntologyDraftKind;
  basis: CorrectionBasis;
};
type CleanupWorkspace = {
  document: string;
  scope: OntologyScope;
  documents: DocumentKnowledge[];
};
/** 문서·대상·작업은 주소에 두고 대상별 초안은 같은 권한 범위 안에서 별도로 보관합니다. */
export function OntologyMapWorkspace(): JSX.Element {
  const [search, setSearch] = useSearchParams();
  const workspaceActive = useWorkspaceActivity();
  const route = ontologyWorkspaceRoute(search);
  const {
    scopeDocument: explicitScopeDocument,
    targetDocument,
    view,
    claimId,
    conceptId,
    routeKey,
    taskKind,
    activeDraftKey,
    inspectorOpen,
    pageTaskOpen,
    taskOpen,
    detailTab,
  } = route;
  // 작업 대상 선택은 전체 작성·검토·정리의 조회 범위를 고정하지 않는다.
  const multiDocumentTask =
    view === 'relation-new' || view === 'reviews' || view === 'cleanup';
  const scopeDocument =
    explicitScopeDocument ?? (multiDocumentTask ? null : targetDocument);
  const [query, setQuery] = useState('');
  const [indexOpen, setIndexOpen] = useState(false);
  const [drafts, setDrafts] = useState<OntologyDraft[]>([]);
  const [cleanupWorkspaces, setCleanupWorkspaces] = useState<
    CleanupWorkspace[]
  >([]);
  const [graphMemory] = useState<Map<string, OntologyGraphView>>(
    (): Map<string, OntologyGraphView> => new Map(),
  );
  const [basisError, setBasisError] = useState<OntologyFailure | null>(null);
  const [loadingBasis, setLoadingBasis] = useState(false);
  const mounted = useRef(true);
  const relationPicker = useRef<((entityId: string) => void) | null>(null);
  const setRelationPicker = useCallback(
    (picker: ((entityId: string) => void) | null): void => {
      relationPicker.current = picker;
    },
    [],
  );
  const requestGeneration = useRef(0);
  const attemptedDocument = useRef('');
  const model = useOntologyMap(clearScopedState, scopeDocument);
  const {
    documents,
    reviewDocuments,
    graph,
    concepts,
    types,
    incomplete,
    outdated,
    targetKnowledge,
    selectedAssertion,
    focus,
    missingAssertionFocus,
    selection,
    relationReady,
    relationDefaultDocument,
    cleanupDocument,
    candidate,
    policy,
  } = ontologyWorkspaceView(model.snapshot, route, query);
  const scopeLost = !!model.error && invalidatesScope(model.error);
  // 패널 여백·선택 강조·열기/닫기가 같은 현재 선택을 기준으로 판단합니다.
  const inspectorVisible = inspectorOpen && !!selection && !scopeLost;
  const selectedConceptKey =
    selection?.kind === 'concept' && inspectorOpen ? selection.value.key : null;
  const focusSelected = selectedConceptKey === focus?.key;
  const activeDraft = drafts.find(
    (draft: OntologyDraft): boolean => draft.key === activeDraftKey,
  );
  if (
    view === 'cleanup' &&
    model.snapshot &&
    cleanupDocument &&
    !cleanupWorkspaces.some(
      (entry: CleanupWorkspace): boolean => entry.document === cleanupDocument,
    )
  ) {
    setCleanupWorkspaces([
      ...cleanupWorkspaces,
      { document: cleanupDocument, scope: model.snapshot.scope, documents },
    ]);
  }
  // 새 관계는 지도 오른쪽 패널로 열고, 나머지 작업은 지도를 가리는 작업 페이지로 엽니다.
  const relationPanelOpen = view === 'relation-new' && !scopeLost;
  /** 같은 계정의 다른 대상 초안을 덮지 않고 주소의 대상만 명시적으로 엽니다. */
  function navigateTo(
    values: Record<string, string | null>,
    replace: boolean = false,
  ): void {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearch(next, { replace });
  }
  /** 작업을 마치거나 닫으면 같은 대상 상세 또는 문서별 지도에 복귀합니다. */
  function closeTask(): void {
    navigateTo({
      view: claimId || conceptId ? 'detail' : null,
      mode: null,
      saved: null,
    });
  }
  /** 주소에서 선택한 대상을 없애고 기존 지도 배율과 초안을 유지합니다. */
  function closeDetails(): void {
    navigateTo({
      view: null,
      mode: null,
      claim: null,
      concept: null,
      document: null,
      saved: null,
    });
  }
  /** 새 관계 패널이 열려 있으면 개념을 빈 주체·대상 칸에 채우고 지도 초점만 옮깁니다. */
  function pickRelationConcept(concept: MapConcept): void {
    if (concept.document === targetDocument)
      relationPicker.current?.(concept.entity.id);
    navigateTo({ focus: concept.key });
  }
  function setDetailTab(tab: string): void {
    navigateTo({ tab });
  }
  function clearScopedState(): void {
    requestGeneration.current += 1;
    attemptedDocument.current = '';
    setLoadingBasis(false);
    setBasisError(null);
    setDrafts([]);
    setCleanupWorkspaces([]);
    graphMemory.clear();
    setQuery('');
  }
  function invalidate(): void {
    clearScopedState();
    model.invalidate();
  }
  function selectConcept(concept: MapConcept): void {
    navigateTo({
      view: 'detail',
      document: concept.document,
      concept: concept.entity.id,
      claim: null,
      mode: null,
      focus: concept.key,
      saved: null,
    });
  }
  /** 지도 카드를 한 번 누르면 지도 중심은 그대로 두고 오른쪽에 개념 정보만 엽니다. */
  function inspectConcept(concept: MapConcept): void {
    navigateTo({
      view: 'detail',
      document: concept.document,
      concept: concept.entity.id,
      claim: null,
      mode: null,
      focus: focus?.key ?? concept.key,
      saved: null,
    });
  }
  /** 카드를 두 번 누르거나 상세의 이동 버튼을 누르면 그 개념을 지도의 중심으로 옮기고 상세를 닫습니다. */
  function moveFocus(concept: MapConcept): void {
    navigateTo({
      view: null,
      document: null,
      concept: null,
      claim: null,
      mode: null,
      focus: concept.key,
      saved: null,
    });
  }
  function selectAssertion(
    assertion: MapAssertion,
    nextMode: 'edit' | 'review' | null = null,
  ): void {
    navigateTo({
      view: 'detail',
      document: assertion.document,
      claim: assertion.claim?.claim_id || assertion.key,
      concept: null,
      mode: nextMode,
      focus:
        focus?.document === assertion.document &&
        (assertion.subject === focus.key || assertion.object === focus.key)
          ? focus.key
          : null,
      tab: null,
      saved: null,
    });
  }
  function beginCorrection(assertion: MapAssertion): void {
    selectAssertion(assertion, 'edit');
  }
  function beginReview(assertion: MapAssertion): void {
    selectAssertion(assertion, 'review');
  }
  function beginRelation(knowledge: DocumentKnowledge): void {
    navigateTo({
      view: 'relation-new',
      document: knowledge.document,
      claim: null,
      concept: null,
      mode: null,
      saved: null,
    });
  }
  function discardDraft(key: string): void {
    setDrafts((previous: OntologyDraft[]): OntologyDraft[] =>
      previous.filter((draft: OntologyDraft): boolean => draft.key !== key),
    );
    closeTask();
  }
  const currentTask = useRef({ active: workspaceActive, key: activeDraftKey });
  useEffect((): void => {
    currentTask.current = { active: workspaceActive, key: activeDraftKey };
  }, [workspaceActive, activeDraftKey]);
  /** 저장된 실제 주장을 다시 읽은 뒤 현재 작업에만 결과 상세를 표시합니다. */
  async function didSave(
    draft: OntologyDraft,
    receipt: CorrectionReceipt,
  ): Promise<void> {
    const knowledge = await model.refreshDocument(
      draft.basis.assertion.document,
    );
    if (
      !knowledge ||
      !currentTask.current.active ||
      currentTask.current.key !== draft.key
    )
      return;
    const created = (knowledge.currentClaims ?? knowledge.claims).find(
      (claim: KnowledgeClaim): boolean =>
        claim.authored_event_id === receipt.eventId,
    );
    const savedClaim =
      draft.kind === 'relation-new'
        ? created?.claim_id
        : draft.basis.assertion.claim?.claim_id;
    if (!savedClaim) return;
    setDrafts((previous: OntologyDraft[]): OntologyDraft[] =>
      previous.filter((item: OntologyDraft): boolean => item.key !== draft.key),
    );
    navigateTo(
      {
        view: 'detail',
        document: knowledge.document,
        claim: savedClaim,
        concept: null,
        mode: null,
        saved: receipt.eventId,
      },
      true,
    );
  }
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);
  // 링크 대상이 현재 목록 페이지 밖이어도 그 문서를 직접 읽고 임의 첫 문서를 선택하지 않습니다.
  const ensureTarget = useEffectEvent((): void => {
    if (
      !targetDocument ||
      !model.snapshot ||
      model.loading ||
      targetKnowledge ||
      scopeLost
    )
      return;
    if (attemptedDocument.current === routeKey) return;
    attemptedDocument.current = routeKey;
    void model.refreshDocument(targetDocument);
  });
  useEffect((): void => {
    ensureTarget();
  }, [
    routeKey,
    model.snapshot,
    model.loading,
    targetDocument,
    targetKnowledge,
    scopeLost,
  ]);
  // 사용자가 ‘대상 문서 변경’을 눌렀다면 기본 문서로 다시 채우지 않고 선택을 기다립니다.
  const choosingRelationDocument = useRef(false);
  useEffect((): void => {
    if (view !== 'relation-new' || targetDocument)
      choosingRelationDocument.current = false;
  }, [view, targetDocument]);
  // 문서가 정해진 새 관계(주소로 직접 연 경우 포함)는 문서 선택 없이 바로 입력 화면을 엽니다.
  const openDefaultRelationDocument = useEffectEvent((): void => {
    if (
      view !== 'relation-new' ||
      targetDocument ||
      choosingRelationDocument.current ||
      !model.snapshot ||
      model.loading ||
      scopeLost
    )
      return;
    const only = relationReady.find(
      (item: DocumentKnowledge): boolean =>
        item.document === relationDefaultDocument,
    );
    if (only) navigateTo({ document: only.document }, true);
  });
  useEffect((): void => {
    openDefaultRelationDocument();
  }, [view, targetDocument, model.snapshot, model.loading, scopeLost]);
  // 주소 복원과 브라우저 뒤로가기도 동일한 고정 기준 읽기를 사용합니다.
  const prepareDraft = useEffectEvent((request: number): void => {
    setBasisError(null);
    setLoadingBasis(false);
    if (
      !taskKind ||
      !activeDraftKey ||
      activeDraft ||
      !targetKnowledge ||
      !model.snapshot ||
      scopeLost
    )
      return;
    const assertion: MapAssertion | null =
      taskKind === 'relation-new'
        ? {
            key: targetKnowledge.document,
            document: targetKnowledge.document,
            knowledge: targetKnowledge,
            claim: null,
            value: {},
            label: '',
            subject: '',
            object: null,
            origin: 'machine',
            collection: 'relations',
          }
        : selectedAssertion;
    if (!assertion) return;
    setLoadingBasis(true);
    void loadCorrectionBasis(
      assertion,
      model.snapshot.scope,
      taskKind === 'edit' ? 'correction' : 'review',
    ).then((result: Awaited<ReturnType<typeof loadCorrectionBasis>>): void => {
      if (!mounted.current || request !== requestGeneration.current) return;
      setLoadingBasis(false);
      if (!result.ok) {
        if (invalidatesScope(result.error)) invalidate();
        else setBasisError(result.error);
        return;
      }
      const draft: OntologyDraft = {
        key: activeDraftKey,
        kind: taskKind,
        basis: result.data,
      };
      setDrafts((previous: OntologyDraft[]): OntologyDraft[] =>
        previous.some((item: OntologyDraft): boolean => item.key === draft.key)
          ? previous
          : [...previous, draft],
      );
    });
  });
  useEffect((): (() => void) => {
    prepareDraft(++requestGeneration.current);
    return (): void => {
      requestGeneration.current += 1;
    };
  }, [
    routeKey,
    activeDraftKey,
    activeDraft,
    targetKnowledge,
    model.snapshot?.scope,
    scopeLost,
  ]);
  /** 초안별 작성 화면이 공통으로 받는 입력입니다. */
  function draftProps(draft: OntologyDraft): {
    basis: CorrectionBasis;
    open: boolean;
    onClose: () => void;
    onSaved: (receipt: CorrectionReceipt) => void;
    onInvalidate: () => void;
    onDiscard: () => void;
  } {
    return {
      basis: draft.basis,
      open: draft.key === activeDraftKey && !scopeLost,
      onClose: closeTask,
      onSaved: (receipt: CorrectionReceipt): void =>
        void didSave(draft, receipt),
      onInvalidate: invalidate,
      onDiscard: (): void => discardDraft(draft.key),
    };
  }
  const basisLoadingText = '현재 원문과 작성 기준을 확인하고 있습니다.';
  const unreadableText =
    '선택한 작성·검토 대상을 읽을 수 없습니다. 문서와 최신 추출 상태를 확인해 주세요.';
  const targetUnreadable =
    !!taskKind &&
    !!targetDocument &&
    !activeDraft &&
    !loadingBasis &&
    !basisError &&
    !model.loading;
  // 새 관계 패널은 초안이 열리기 전까지 문서 선택·읽는 중·오류 상태를 대신 보입니다.
  const relationStatus: JSX.Element | null =
    activeDraft ? null : !targetDocument ? (
      <OntologyRelationDocumentChoice
        documents={documents}
        ready={relationReady}
        loading={model.loading}
        hasMore={!!model.snapshot?.nextCursor}
        onChoose={beginRelation}
        onLoadMore={model.loadMore}
      />
    ) : (
      <div className={styles.inspector}>
        {loadingBasis && (
          <p className={styles.notice} role="status">
            {basisLoadingText}
          </p>
        )}
        {basisError && (
          <div className={styles.error} role="alert">
            <p>{basisError.message}</p>
            <button type="button" onClick={closeTask}>
              대상으로 돌아가기
            </button>
          </div>
        )}
        {targetUnreadable && (
          <>
            <p>{unreadableText}</p>
            <Link to={`/document?path=${encodeURIComponent(targetDocument)}`}>
              대상 문서 열기
            </Link>
          </>
        )}
      </div>
    );
  // 헤더는 제목과 "새 관계" 하나만 둡니다. 정리·문서별 검토는 직접 주소로만 열립니다.
  const workspaceHeader = (
    <div className={styles.header}>
      <div>
        <button
          type="button"
          className={`${styles.indexToggle} ${styles.iconButton}`}
          aria-expanded={indexOpen}
          disabled={!focus}
          aria-label={indexOpen ? '개념 목록 닫기' : '개념 목록 열기'}
          title={indexOpen ? '개념 목록 닫기' : '개념 목록 열기'}
          onClick={(): void => setIndexOpen(!indexOpen)}
        >
          <Icon name="panel-left" />
        </button>
        {scopeDocument && (
          <span className={styles.scopeChip}>
            <Icon name="file-text" size={14} />
            문서별 지도 · {documentDisplayName(scopeDocument)}
          </span>
        )}
        {scopeDocument && (
          <Link to="/ontology">
            {search.get('from') === 'map'
              ? '여러 문서 지도로 돌아가기'
              : '여러 문서 지도'}
          </Link>
        )}
      </div>
      <HeaderActions>
        <Button
          variant="secondary"
          className={styles.newRelation}
          disabled={model.loading || !model.snapshot}
          onClick={(): void => {
            navigateTo({
              view: 'relation-new',
              document: scopeDocument || relationDefaultDocument,
              claim: null,
              concept: null,
              mode: null,
              saved: null,
            });
          }}
        >
          <Icon name="plus" /> 새 관계
        </Button>
      </HeaderActions>
    </div>
  );
  const hasNotices = Boolean(
    (model.error && model.snapshot) ||
    outdated.length > 0 ||
    (model.snapshot && incomplete),
  );
  // 조회 안내는 대상 헤더 아래의 작업 면에 표시합니다.
  const workspaceNotices = hasNotices ? (
    <>
      {model.error && model.snapshot && (
        <div role="alert" className={styles.error}>
          <strong>온톨로지를 불러오지 못했습니다.</strong>{' '}
          <span>{model.error.message}</span>
          {model.snapshot && <span> 이전 그래프를 표시하고 있습니다.</span>}
          <div className={styles.actions}>
            <button
              type="button"
              onClick={model.reload}
              disabled={model.loading}
            >
              다시 불러오기
            </button>
            <Link to="/settings">연결하기</Link>
          </div>
        </div>
      )}
      {outdated.length > 0 && (
        <div className={styles.notice} role="status">
          문서 {outdated.length}개의 관계가 최신이 아니거나 검토가 필요합니다.
        </div>
      )}
      {model.snapshot && incomplete && (
        <div className={styles.range}>
          현재 읽은 문서 {model.snapshot.documents.length}개 안에서 탐색합니다.
          {model.snapshot.nextCursor
            ? ' 다음 문서 범위가 있습니다.'
            : ' 누락된 자료가 있어 전체 결과가 아닙니다.'}
          {model.snapshot.skipped.length > 0 && (
            <details>
              <summary>
                읽지 못한 항목 {model.snapshot.skipped.length}개
              </summary>
              {model.snapshot.skipped.map(
                (item: string, index: number): JSX.Element => (
                  <p key={`${item}:${index}`}>{item}</p>
                ),
              )}
            </details>
          )}
        </div>
      )}
    </>
  ) : null;
  return (
    <section className={styles.root} aria-label="온톨로지 탐색">
      <div className={styles.mapWorkspace} hidden={pageTaskOpen}>
        {!focus && (
          <header
            className={styles.looseHeader}
            data-scoped={Boolean(scopeDocument)}
          >
            {workspaceHeader}
          </header>
        )}
        {/* 읽은 그래프가 없으면 뒤 바탕만 보이지 않도록 본문 자리를 카드로 채웁니다. */}
        {model.error && !model.snapshot && (
          <EmptyState
            framed
            title="온톨로지를 불러오지 못했습니다"
            description={model.error.message}
            action={
              <>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={model.reload}
                  disabled={model.loading}
                >
                  다시 불러오기
                </Button>
                <Link to="/settings">연결하기</Link>
              </>
            }
          />
        )}
        {!focus && hasNotices && (
          <div className={styles.noticePanel}>{workspaceNotices}</div>
        )}
        {model.loading && !model.snapshot && (
          <EmptyState
            framed
            icon="network"
            title="개념과 관계를 불러오고 있습니다"
          />
        )}
        {!model.loading && !model.error && graph.concepts.length === 0 && (
          <EmptyState
            framed
            icon="network"
            title={
              incomplete
                ? '현재 불러온 문서에 개념이 없습니다'
                : '아직 추출된 개념이 없습니다'
            }
            description={
              incomplete
                ? '문서를 더 불러오거나 조회 상태를 확인해 주세요.'
                : '문서를 등록하고 관계를 추출해 주세요.'
            }
            action={
              <div className={styles.actions}>
                <Link to="/documents">문서에서 추출 확인</Link>
                <Link to="/register">문서 추가</Link>
                {model.snapshot?.nextCursor && (
                  <button type="button" onClick={model.loadMore}>
                    다음 문서 범위 읽기
                  </button>
                )}
              </div>
            }
          />
        )}
        {focus && (
          <OntologyMapLayout
            header={workspaceHeader}
            scoped={Boolean(scopeDocument)}
            detailsLabel={
              relationPanelOpen
                ? '새 관계'
                : selection?.kind === 'concept'
                  ? '개념 정보'
                  : '관계·속성 상세'
            }
            closeLabel={relationPanelOpen ? '새 관계 닫기' : '상세 닫기'}
            detailsOpen={relationPanelOpen || inspectorVisible}
            overlayDetails={!relationPanelOpen}
            indexOpen={indexOpen}
            onCloseDetails={relationPanelOpen ? closeTask : closeDetails}
            index={
              <aside
                className={styles.explorer}
                id="ontology-concept-pane"
                aria-label="개념 탐색"
              >
                <div className={styles.search}>
                  <label htmlFor="ontology-concept-search">개념 탐색</label>
                  <input
                    id="ontology-concept-search"
                    type="search"
                    placeholder="개념 이름 찾기"
                    value={query}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      setQuery(event.target.value)
                    }
                  />
                </div>
                {hasNotices && (
                  <div className={styles.mobileNotices}>{workspaceNotices}</div>
                )}
                <div className={styles.conceptScroll}>
                  {types.map((type: string): JSX.Element => (
                    <details key={type} open>
                      <summary>
                        {ontologyTermLabel(type)}
                        <span>
                          {
                            concepts.filter(
                              (concept: MapConcept): boolean =>
                                concept.entity.type === type,
                            ).length
                          }
                        </span>
                      </summary>
                      {concepts
                        .filter(
                          (concept: MapConcept): boolean =>
                            concept.entity.type === type,
                        )
                        .map((concept: MapConcept): JSX.Element => (
                          <button
                            type="button"
                            key={concept.key}
                            aria-current={
                              concept.key === focus.key ? 'true' : undefined
                            }
                            title={`${concept.entity.label} · ${concept.document}`}
                            onClick={(): void => {
                              if (relationPanelOpen) {
                                pickRelationConcept(concept);
                                setIndexOpen(false);
                                return;
                              }
                              navigateTo({
                                focus: concept.key,
                                view: null,
                                document: null,
                                claim: null,
                                concept: null,
                                mode: null,
                                saved: null,
                              });
                              setIndexOpen(false);
                            }}
                          >
                            <span>
                              {concept.entity.label}
                              <small>
                                {documentDisplayName(concept.document)}
                              </small>
                            </span>
                            <small>
                              연결{' '}
                              {
                                graph.assertions.filter(
                                  (assertion: MapAssertion): boolean =>
                                    assertion.subject === concept.key ||
                                    assertion.object === concept.key,
                                ).length
                              }
                              개
                            </small>
                          </button>
                        ))}
                    </details>
                  ))}
                  {concepts.length === 0 && (
                    <p className={styles.noMatch}>
                      일치하는 개념이 없습니다.
                      <button type="button" onClick={(): void => setQuery('')}>
                        검색어 지우기
                      </button>
                    </p>
                  )}
                </div>
                <footer className={styles.conceptFoot}>
                  {graph.concepts.length}개 개념 ·{' '}
                  {model.snapshot?.documents.length}개 문서
                  {model.snapshot?.nextCursor && (
                    <button
                      type="button"
                      disabled={model.loading}
                      onClick={model.loadMore}
                    >
                      다음 문서 범위 읽기
                    </button>
                  )}
                </footer>
              </aside>
            }
            details={
              <>
                {hasNotices && (
                  <div className={styles.mobileNotices}>{workspaceNotices}</div>
                )}
                {relationPanelOpen && relationStatus}
                {drafts.map((draft: OntologyDraft): JSX.Element | null =>
                  draft.kind === 'relation-new' ? (
                    <OntologyRelationPanel
                      key={draft.key}
                      {...draftProps(draft)}
                      onPickerChange={setRelationPicker}
                      onChooseDocument={
                        scopeDocument
                          ? undefined
                          : (): void => {
                              choosingRelationDocument.current = true;
                              navigateTo({ document: null });
                            }
                      }
                    />
                  ) : null,
                )}
                <div className={styles.inspector} hidden={relationPanelOpen}>
                  {selectedAssertion && (
                    <>
                      <OntologyAssertionDetails
                        assertion={selectedAssertion}
                        section="summary"
                      />
                      <div className={styles.inspectorActions}>
                        {!candidate &&
                          !policy &&
                          !selectedAssertion.claim?.authored_event_id && (
                            <button
                              type="button"
                              disabled={
                                loadingBasis ||
                                !model.snapshot?.scope.permissions.includes(
                                  'ontology_review',
                                )
                              }
                              onClick={(): void => {
                                beginCorrection(selectedAssertion);
                              }}
                            >
                              원문 근거 정정
                            </button>
                          )}
                        <button
                          type="button"
                          className={styles.primaryAction}
                          disabled={loadingBasis || !selectedAssertion.claim}
                          onClick={(): void => {
                            beginReview(selectedAssertion);
                          }}
                        >
                          검토·전문가 판단
                        </button>
                      </div>
                      <Tabs
                        label="선택 관계 내용"
                        value={detailTab}
                        onValueChange={setDetailTab}
                        items={[
                          {
                            id: 'information',
                            label: '관계 정보',
                            content: (
                              <OntologyAssertionDetails
                                assertion={selectedAssertion}
                                section="information"
                              />
                            ),
                          },
                          {
                            id: 'history',
                            label: '검토 기록',
                            content: (
                              <OntologyReviewHistory
                                key={
                                  selectedAssertion.key +
                                  selectedAssertion.knowledge.stateRevision
                                }
                                assertion={selectedAssertion}
                              />
                            ),
                          },
                        ]}
                      />

                      {basisError && (
                        <div role="alert" className={styles.error}>
                          {basisError.message}
                        </div>
                      )}
                    </>
                  )}
                  {selection?.kind === 'concept' && (
                    <OntologyConceptDetails
                      concept={selection.value}
                      assertions={graph.assertions}
                      knowledge={
                        documents.find(
                          (item: DocumentKnowledge): boolean =>
                            item.document === selection.value.document,
                        ) ?? null
                      }
                      scope={model.snapshot?.scope ?? null}
                      active={workspaceActive && inspectorVisible}
                      onScopeInvalidated={invalidate}
                      onSelectAssertion={(edge: MapEdge): void => {
                        const assertion = graph.assertions.find(
                          (item: MapAssertion): boolean =>
                            item.key === edge.key,
                        );
                        if (assertion) selectAssertion(assertion);
                      }}
                      onMove={
                        selection.value.key === focus.key
                          ? undefined
                          : moveFocus
                      }
                    />
                  )}
                </div>
              </>
            }
          >
            <div className={styles.graphZone}>
              {missingAssertionFocus ? (
                <>
                  {hasNotices && (
                    <div className={styles.noticePanel}>{workspaceNotices}</div>
                  )}
                  <div className={styles.empty}>
                    <h2>이 주장의 개념을 현재 지도에서 찾을 수 없습니다</h2>
                    <p>
                      선택한 주장의 근거와 기록은 상세에서 확인할 수 있습니다.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <OntologyGraphCanvas
                    notices={workspaceNotices}
                    heading={
                      <div className={styles.focusBar}>
                        <button
                          type="button"
                          className={styles.focusCard}
                          aria-pressed={focusSelected}
                          title="누르면 개념 정보를 열고 닫습니다"
                          onClick={(): void =>
                            focusSelected
                              ? closeDetails()
                              : selectConcept(focus)
                          }
                        >
                          <h2>{focus.entity.label}</h2>
                          <span>{ontologyTermLabel(focus.entity.type)}</span>
                        </button>
                      </div>
                    }
                    memory={graphMemory}
                    graph={graph}
                    focus={focus}
                    selectedKey={selectedAssertion?.key || null}
                    selectedConceptKey={selectedConceptKey}
                    coveredRight={inspectorVisible ? 372 : 0}
                    onSelectAssertion={(edge: MapEdge): void => {
                      const assertion = graph.assertions.find(
                        (item: MapAssertion): boolean => item.key === edge.key,
                      );
                      if (assertion) selectAssertion(assertion);
                    }}
                    onSelectConcept={
                      relationPanelOpen ? pickRelationConcept : inspectConcept
                    }
                    onMoveConcept={moveFocus}
                    onClearSelection={(): void => {
                      if (inspectorOpen && !relationPanelOpen) closeDetails();
                    }}
                  />
                </>
              )}
            </div>
          </OntologyMapLayout>
        )}
      </div>
      {search.get('saved') && !taskOpen && (
        <p className={styles.notice} role="status">
          관계 변경이 저장되었습니다. 현재 상세와 기록을 확인할 수 있습니다.
        </p>
      )}
      {inspectorOpen && !selection && !model.loading && (
        <div className={styles.error} role="alert">
          <p>
            선택한 개념·관계를 현재 조회에서 찾을 수 없습니다. 이전 버전 또는
            접근 상태를 확인해 주세요.
          </p>
          <button type="button" onClick={closeDetails}>
            지도와 목록으로 돌아가기
          </button>
        </div>
      )}
      {pageTaskOpen && model.error && (
        <div className={styles.error} role="alert">
          {model.error.message}
        </div>
      )}
      {pageTaskOpen && loadingBasis && (
        <p className={styles.notice} role="status">
          {basisLoadingText}
        </p>
      )}
      {pageTaskOpen && basisError && (
        <div className={styles.error} role="alert">
          <p>{basisError.message}</p>
          <button type="button" onClick={closeTask}>
            대상으로 돌아가기
          </button>
        </div>
      )}
      {taskKind !== 'relation-new' && targetUnreadable && targetDocument && (
        <WorkspacePage title="대상 확인" onBack={closeTask}>
          <p>{unreadableText}</p>
          <Link to={`/document?path=${encodeURIComponent(targetDocument)}`}>
            대상 문서 열기
          </Link>
        </WorkspacePage>
      )}
      <WorkspacePage
        hidden={view !== 'reviews'}
        title="문서별 관계 검토"
        onBack={closeTask}
      >
        {documents.length === 0 && (
          <p>
            검토할 문서가 없습니다.{' '}
            <Link to="/documents">문서 목록에서 확인</Link>
          </p>
        )}
        <p>거절·보류된 주장과 미확정 후보도 선택해 검토할 수 있습니다.</p>
        {basisError && <p role="alert">{basisError.message}</p>}
        {reviewDocuments.map(
          ({
            knowledge,
            current,
            historical,
          }: OntologyReviewDocument): JSX.Element => (
            <section key={knowledge.document}>
              <h3>{documentDisplayName(knowledge.document)}</h3>
              {current.map(
                ({ claim, label }: OntologyReviewRow): JSX.Element => (
                  <button
                    className={styles.attribute}
                    type="button"
                    key={claim.claim_id}
                    disabled={loadingBasis}
                    onClick={(): void => {
                      const assertion = reviewAssertion(knowledge, claim);
                      beginReview(assertion);
                    }}
                  >
                    <strong>{label}</strong>
                    <small>
                      {claim.collection === 'relation_candidates'
                        ? '후보 · '
                        : ''}
                      {{
                        unreviewed: '검토 대기',
                        accept: '확인됨',
                        edit: '정정됨',
                        reject: '거절',
                        defer: '보류',
                        policy: '전문가 판단',
                        past: '과거 기록',
                      }[claim.decision] ?? '판단 확인 필요'}
                    </small>
                  </button>
                ),
              )}
              {historical.length > 0 && (
                <details>
                  <summary>과거·정리된 관계 기록</summary>
                  {historical.map(
                    ({ claim, label }: OntologyReviewRow): JSX.Element => (
                      <button
                        type="button"
                        className={styles.attribute}
                        key={claim.claim_id}
                        disabled={loadingBasis}
                        onClick={(): void => {
                          beginReview(reviewAssertion(knowledge, claim));
                        }}
                      >
                        {label} · 기록 조회
                      </button>
                    ),
                  )}
                </details>
              )}
              {current.length === 0 && <p>현재 검토 목록에 주장이 없습니다.</p>}
            </section>
          ),
        )}

        {model.snapshot?.nextCursor && (
          <button
            type="button"
            disabled={model.loading}
            onClick={model.loadMore}
          >
            다음 문서 범위 읽기
          </button>
        )}
      </WorkspacePage>
      {drafts.map((draft: OntologyDraft): JSX.Element | null => {
        if (draft.kind === 'review')
          return <OntologyReviewPage key={draft.key} {...draftProps(draft)} />;
        if (draft.kind === 'edit')
          return (
            <OntologyCorrectionPage key={draft.key} {...draftProps(draft)} />
          );
        return null;
      })}
      {cleanupWorkspaces.map((entry: CleanupWorkspace): JSX.Element => (
        <OntologyCleanupPage
          key={entry.document}
          scope={entry.scope}
          documents={
            documents.some(
              (item: DocumentKnowledge): boolean =>
                item.document === entry.document,
            )
              ? documents
              : entry.documents
          }
          incomplete={incomplete}
          selectedDocument={entry.document}
          onDocumentChange={(document: string): void =>
            navigateTo({ document })
          }
          open={
            view === 'cleanup' &&
            entry.document === cleanupDocument &&
            !scopeLost
          }
          onClose={closeTask}
          onChanged={(): void => {
            void model.refreshDocument(entry.document);
          }}
          onInvalidate={invalidate}
        />
      ))}
      {view === 'cleanup' && !cleanupDocument && !model.loading && (
        <WorkspacePage title="Clean Up" onBack={closeTask}>
          <p>
            정리할 문서가 없습니다.{' '}
            <Link to="/documents">문서 목록에서 확인</Link>
          </p>
        </WorkspacePage>
      )}
      {!taskOpen && drafts.length > 0 && !scopeLost && (
        <details className={styles.draftNotice}>
          <summary>보관한 작성·검토 {drafts.length}개</summary>
          {drafts.map((draft: OntologyDraft): JSX.Element => (
            <button
              key={draft.key}
              type="button"
              onClick={(): void =>
                navigateTo({
                  view:
                    draft.kind === 'relation-new' ? 'relation-new' : 'detail',
                  document: draft.basis.assertion.document,
                  path: scopeDocument ? draft.basis.assertion.document : null,
                  claim: draft.basis.assertion.claim?.claim_id || null,
                  concept: null,
                  mode: draft.kind === 'relation-new' ? null : draft.kind,
                  saved: null,
                })
              }
            >
              {draft.basis.assertion.document} ·{' '}
              {draft.kind === 'relation-new'
                ? '새 관계'
                : draft.kind === 'edit'
                  ? '원문 정정'
                  : '검토'}{' '}
              · {draft.basis.assertion.label}
            </button>
          ))}
        </details>
      )}
    </section>
  );
}
