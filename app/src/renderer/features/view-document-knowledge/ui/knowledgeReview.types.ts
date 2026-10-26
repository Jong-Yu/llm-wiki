import type { KnowledgeValue } from '@contracts/knowledge.contract';

/** 검토 화면에는 실제 주장 ID와 조회 당시 복합 판본을 함께 전달합니다. */
export type KnowledgeReviewSelection = {
  document: string;
  claimId: string;
  stateRevision: string;
  collection: 'relations' | 'attributes' | 'relation_candidates';
  value: KnowledgeValue;
  reviewedValue?: KnowledgeValue;
  title?: string;
  ambiguous?: boolean;
};
