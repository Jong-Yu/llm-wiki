import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeEntity,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import type { OntologyMapSourceAnchor } from '@contracts/ontologyExploration.contract';

export type OntologyScope = WorkspaceScope & {
  connectionId: string;
  permissions: string[];
};
export type OntologyFailure = {
  code: string;
  message: string;
  status?: number;
  retry?: 'none' | 'read_again' | 'same_basis' | 'reconcile';
  cleanupWarningCount?: number;
};
export type OntologyOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: OntologyFailure };
export type OntologySnapshot = {
  scope: OntologyScope;
  documents: DocumentKnowledge[];
  nextCursor: string | null;
  incomplete: boolean;
  skipped: string[];
};
export type MapConcept = {
  key: string;
  document: string;
  entity: KnowledgeEntity;
  /** 부분 조회의 속성과 직접 연결 전체 수를 전체 지식으로 가장하지 않고 전달합니다. */
  attributeCount?: number;
  relationCount?: number;
  /** 전체 원문이 아닌 위치 요약이며 개체 조회·주제 추가의 대상으로 쓰지 않습니다. */
  sourceAnchor?: OntologyMapSourceAnchor;
};
/** 지도는 관계 끝점과 표시 정보만 사용하며 저장·검토에는 전체 주장을 따로 읽습니다. */
export type MapEdge = {
  key: string;
  document: string;
  subject: string;
  object: string | null;
  label: string;
  origin: 'machine' | 'expert' | 'candidate';
  collection: KnowledgeClaim['collection'];
  /** 한정어를 포함한 접근성 설명이며 원문 주장의 의미를 단순화하지 않습니다. */
  description?: string;
};
export type MapAssertion = MapEdge & {
  value: KnowledgeValue;
  claim: KnowledgeClaim | null;
  knowledge: DocumentKnowledge;
};
export type OntologyGraph = {
  concepts: MapConcept[];
  assertions: MapAssertion[];
};
export type OntologyCanvasGraph = {
  concepts: MapConcept[];
  assertions: MapEdge[];
};
export type CorrectionBasis = {
  scope: OntologyScope;
  assertion: MapAssertion;
  body: string;
};
export type CorrectionReceipt = {
  eventId: string;
  stateRevision: string;
  cleanupWarningCount: number;
};
