import { z } from 'zod';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { CorrectionBasis } from './ontologyMap.types';

/** 사람이 추가하는 관계는 항상 전문가 의견이며 원문 인용은 받지 않습니다. 양태는 화면에서 숨기고 기본 "사실"로 둡니다. */
export const relationSchema = z.object({
  kind: z.literal('policy'),
  subject: z.string().min(1, '주체를 선택해 주세요.'),
  object: z.string().min(1, '대상을 선택해 주세요.'),
  predicate: z.string().trim().min(1, '관계를 선택해 주세요.'),
  polarity: z.enum(['positive', 'negative']),
  modality: z.enum([
    'asserted',
    'possible',
    'capability',
    'planned',
    'hypothetical',
  ]),
  condition: z.string().max(1000),
  scope: z.string().max(1000),
  time: z.string().max(1000),
  reason: z.string().trim().min(1, '이유를 입력해 주세요.').max(1000),
});
export type RelationValues = z.infer<typeof relationSchema>;

// 기존 공개 술어 계약의 개체 간 관계만 제공하며 앵커·다항 대응은 기존 추출 흐름을 사용합니다.
export const relationPredicates = [
  'uses',
  'depends_on',
  'part_of',
  'implements',
  'related_to',
  'authored_by',
  'subclass_of',
  'instance_of',
  'composed_of',
  'located_in',
  'has_input',
  'has_output',
  'participates_in',
  'precedes',
  'causes',
  'enables',
  'prevents',
  'predicts',
  'supports_prediction',
  'measures',
  'observes',
  'view_of',
  'same_as',
  'different_from',
  'responsible_for',
  'approves',
];

export {
  relationPredicateLabel,
  relationPredicateLabels,
} from '@renderer/shared/lib/relationPredicateLabels';

/** 입력 초안은 아직 확정된 주장을 자동 생성하지 않습니다. */
export function relationDefaults(): RelationValues {
  return {
    kind: 'policy',
    subject: '',
    object: '',
    predicate: '',
    polarity: 'positive',
    modality: 'asserted',
    condition: '',
    scope: '',
    time: '',
    reason: '',
  };
}

/** 전문가 의견에는 원문 인용을 붙이지 않고 한정어·현재 관점으로 새 주장 입력을 만듭니다. */
export function relationInput(
  basis: CorrectionBasis,
  values: RelationValues,
): KnowledgeValue {
  const access = basis.assertion.knowledge.access;
  return {
    subject: values.subject,
    predicate: values.predicate,
    object: values.object,
    qualifiers: {
      polarity: values.polarity,
      modality: values.modality,
      condition: values.condition.trim() || null,
      scope: values.scope.trim() || null,
      time: values.time.trim() || null,
    },
    context: {
      domain: access.domain,
      viewpoints: access.viewpoint === null ? [] : [access.viewpoint],
    },
  };
}
