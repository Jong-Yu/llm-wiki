import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { buildOntologyGraph } from './buildOntologyGraph';
import { ontologyClaimLabel, ontologyRecordedEntities } from './ontologyLabels';
import type {
  MapAssertion,
  MapConcept,
  OntologyGraph,
  OntologySnapshot,
} from './ontologyMap.types';
import { historicalReviewTargets, reviewAssertion } from './reviewTargets';

export type OntologyDraftKind = 'edit' | 'review' | 'relation-new';
type InspectorSelection =
  | { kind: 'concept'; value: MapConcept }
  | { kind: 'assertion'; value: MapAssertion };
export type OntologyReviewRow = { claim: KnowledgeClaim; label: string };
export type OntologyReviewDocument = {
  knowledge: DocumentKnowledge;
  current: OntologyReviewRow[];
  historical: OntologyReviewRow[];
};
type OntologyWorkspaceRoute = {
  scopeDocument: string | null;
  targetDocument: string | null;
  claimId: string | null;
  conceptId: string | null;
  focusKey: string | null;
  view: string;
  routeKey: string;
  taskKind: OntologyDraftKind | null;
  activeDraftKey: string | null;
  inspectorOpen: boolean;
  pageTaskOpen: boolean;
  taskOpen: boolean;
  detailTab: 'history' | 'information';
};
type OntologyWorkspaceView = {
  documents: DocumentKnowledge[];
  reviewDocuments: OntologyReviewDocument[];
  graph: OntologyGraph;
  concepts: MapConcept[];
  types: string[];
  incomplete: boolean;
  outdated: DocumentKnowledge[];
  targetKnowledge: DocumentKnowledge | undefined;
  selectedAssertion: MapAssertion | null;
  focus: MapConcept | undefined;
  selection: InspectorSelection | null;
  missingAssertionFocus: boolean;
  relationReady: DocumentKnowledge[];
  relationDefaultDocument: string | null;
  cleanupDocument: string;
  candidate: boolean;
  policy: boolean;
};

/** 주소의 선택과 작업 종류를 같은 규칙으로 읽고 초안의 고정 식별자를 만듭니다. */
export function ontologyWorkspaceRoute(
  search: URLSearchParams,
): OntologyWorkspaceRoute {
  const scopeDocument = search.get('path');
  const targetDocument = search.get('document') || scopeDocument;
  const view = search.get('view') || 'map';
  const mode = search.get('mode');
  const claimId = search.get('claim');
  const taskKind =
    view === 'relation-new'
      ? 'relation-new'
      : mode === 'edit' || mode === 'review'
        ? mode
        : null;
  const pageTaskOpen =
    view === 'reviews' ||
    view === 'cleanup' ||
    (taskKind !== null && taskKind !== 'relation-new');
  return {
    scopeDocument,
    targetDocument,
    claimId,
    conceptId: search.get('concept'),
    focusKey: search.get('focus'),
    view,
    routeKey: search.toString(),
    taskKind,
    activeDraftKey:
      taskKind && targetDocument
        ? JSON.stringify([
            taskKind,
            targetDocument,
            taskKind === 'relation-new' ? null : claimId,
          ])
        : null,
    inspectorOpen: view === 'detail',
    pageTaskOpen,
    taskOpen: pageTaskOpen || view === 'relation-new',
    detailTab: search.get('tab') === 'history' ? 'history' : 'information',
  };
}

/** 현재·과거 주장과 원장 개체를 한 번 읽어 검토 목록과 직접 진입이 같은 대상을 씁니다. */
function reviewDocument(knowledge: DocumentKnowledge): OntologyReviewDocument {
  const events = new Map<unknown, KnowledgeValue>();
  for (const event of [
    ...knowledge.history,
    ...(knowledge.relationHistory ?? []),
  ])
    events.set(event.claim_id, event);
  return {
    knowledge,
    current: (knowledge.currentClaims ?? knowledge.claims).map(
      (claim: KnowledgeClaim): OntologyReviewRow => ({
        claim,
        label: ontologyClaimLabel(
          claim.reviewed_value,
          knowledge.effectiveGraph.entities,
        ),
      }),
    ),
    historical: historicalReviewTargets(knowledge).map(
      (claim: KnowledgeClaim): OntologyReviewRow => ({
        claim,
        label: ontologyClaimLabel(
          claim.value,
          ontologyRecordedEntities(events.get(claim.claim_id)),
        ),
      }),
    ),
  };
}

/** 문서 범위·대상·지도 초점과 검토 행을 파생하며 화면 상태나 서버 자료는 변경하지 않습니다. */
export function ontologyWorkspaceView(
  snapshot: OntologySnapshot | null,
  route: OntologyWorkspaceRoute,
  query: string,
): OntologyWorkspaceView {
  const documents = (snapshot?.documents ?? []).filter(
    (item: DocumentKnowledge): boolean =>
      !route.scopeDocument || item.document === route.scopeDocument,
  );
  const graph = buildOntologyGraph(documents);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const concepts = graph.concepts.filter((concept: MapConcept): boolean =>
    concept.entity.label.toLocaleLowerCase().includes(normalizedQuery),
  );
  const reviewDocuments = documents.map(reviewDocument);
  const target = reviewDocuments.find(
    (item: OntologyReviewDocument): boolean =>
      item.knowledge.document === route.targetDocument,
  );
  const targetKnowledge = target?.knowledge;
  let selectedAssertion =
    graph.assertions.find(
      (item: MapAssertion): boolean =>
        !!route.claimId &&
        item.document === route.targetDocument &&
        (item.claim?.claim_id === route.claimId || item.key === route.claimId),
    ) ?? null;
  if (!selectedAssertion && route.claimId && target) {
    const row = [...target.current, ...target.historical].find(
      (item: OntologyReviewRow): boolean =>
        item.claim.claim_id === route.claimId,
    );
    if (row) selectedAssertion = reviewAssertion(target.knowledge, row.claim);
  }
  let selectedConcept: MapConcept | undefined;
  let assertionFocus: MapConcept | undefined;
  let explicitFocus: MapConcept | undefined;
  for (const concept of graph.concepts) {
    if (
      !selectedConcept &&
      concept.document === route.targetDocument &&
      concept.entity.id === route.conceptId
    )
      selectedConcept = concept;
    if (
      !assertionFocus &&
      (concept.key === selectedAssertion?.subject ||
        (concept.document === selectedAssertion?.document &&
          concept.entity.id === selectedAssertion?.value.subject))
    )
      assertionFocus = concept;
    if (!explicitFocus && concept.key === route.focusKey)
      explicitFocus = concept;
  }
  const selection: InspectorSelection | null = selectedAssertion
    ? { kind: 'assertion', value: selectedAssertion }
    : selectedConcept
      ? { kind: 'concept', value: selectedConcept }
      : null;
  return {
    documents,
    reviewDocuments,
    graph,
    concepts,
    types: [
      ...new Set(
        concepts.map((concept: MapConcept): string => concept.entity.type),
      ),
    ],
    incomplete: Boolean(
      snapshot &&
      (snapshot.incomplete ||
        snapshot.nextCursor ||
        snapshot.skipped.length > 0),
    ),
    outdated: documents.filter(
      (item: DocumentKnowledge): boolean =>
        item.status !== 'ready' ||
        item.machineGraph.needs_reextraction === true ||
        (item.currentPendingHistory ?? item.pendingHistory).length > 0,
    ),
    targetKnowledge,
    selectedAssertion,
    selection,
    focus:
      explicitFocus || assertionFocus || selectedConcept || graph.concepts[0],
    missingAssertionFocus:
      !!selectedAssertion && !route.focusKey && !assertionFocus,
    relationReady: documents.filter(
      (item: DocumentKnowledge): boolean =>
        item.status === 'ready' && item.machineGraph.entities.length > 0,
    ),
    relationDefaultDocument:
      selection?.value.document ||
      (documents.length === 1 ? (documents[0]?.document ?? null) : null),
    cleanupDocument: route.targetDocument || documents[0]?.document || '',
    candidate:
      selectedAssertion?.origin === 'candidate' ||
      selectedAssertion?.claim?.collection === 'relation_candidates',
    policy: selectedAssertion?.claim?.decision === 'policy',
  };
}
