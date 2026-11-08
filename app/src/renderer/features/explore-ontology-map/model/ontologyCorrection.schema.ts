import { z } from 'zod';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type { CorrectionBasis } from './ontologyMap.types';
import { displayValue, valueObject } from './buildOntologyGraph';

export const ontologyCorrectionSchema = z.object({
  subject: z.string(),
  object: z.string(),
  label: z
    .string()
    .trim()
    .min(1, '관계 또는 속성 이름을 입력해 주세요.')
    .max(4096),
  value: z.string().max(4096),
  condition: z.string().max(4096),
  reason: z
    .string()
    .trim()
    .min(1, '수정 이유를 입력해 주세요.')
    .max(1000, '수정 이유는 1000자 이내로 입력해 주세요.'),
});
export type OntologyCorrectionValues = z.infer<typeof ontologyCorrectionSchema>;

/** 처음 읽은 유효값에서만 초안을 만들고 새 판본으로 자동 교체하지 않습니다. */
export function correctionDefaults(
  basis: CorrectionBasis,
): OntologyCorrectionValues {
  const value = basis.assertion.value;
  const condition = valueObject(value.qualifiers)?.condition;
  return {
    subject: typeof value.subject === 'string' ? value.subject : '',
    object: typeof value.object === 'string' ? value.object : '',
    label: basis.assertion.label,
    value: displayValue(value.value),
    condition: typeof condition === 'string' ? condition : '',
    reason: '',
  };
}

/** 서버 입력 형식으로 인용 위치만 변환하며 모든 의미·맥락 필드를 보존합니다. */
function toAssertionInput(value: KnowledgeJson): KnowledgeJson {
  if (Array.isArray(value))
    return value.map((item: KnowledgeJson): KnowledgeJson =>
      toAssertionInput(item),
    );
  if (value === null || typeof value !== 'object') return value;
  const result: KnowledgeValue = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'status') continue;
    const evidence = key === 'evidence' ? valueObject(item) : null;
    result[key] =
      evidence && typeof evidence.quote === 'string'
        ? evidence.quote
        : toAssertionInput(item);
  }
  return result;
}

/** 사용자가 편집한 필드만 바꾸며 방향·단위·극성·양태·출처·관점을 유지합니다. */
export function buildCorrection(
  basis: CorrectionBasis,
  values: OntologyCorrectionValues,
): KnowledgeValue {
  const result = valueObject(toAssertionInput(basis.assertion.value));
  if (!result) throw new Error('수정 기준을 확인할 수 없습니다.');
  for (const field of ['subject', 'object'] as const) {
    if (typeof result[field] !== 'string') continue;
    if (
      !basis.assertion.knowledge.machineGraph.entities.some(
        (
          entity: (typeof basis.assertion.knowledge.machineGraph.entities)[number],
        ): boolean => entity.id === values[field],
      )
    )
      throw new Error('현재 원문 그래프의 개념을 선택해 주세요.');
    result[field] = values[field];
  }
  if (basis.assertion.collection === 'attributes') {
    result.property = values.label;
    if (typeof result.value === 'number') {
      const number = Number(values.value);
      if (!values.value.trim() || !Number.isFinite(number))
        throw new Error('속성 값에는 올바른 숫자를 입력해 주세요.');
      result.value = number;
    } else if (typeof result.value === 'string') result.value = values.value;
  } else result.predicate = values.label;
  const qualifiers = valueObject(result.qualifiers);
  if (qualifiers)
    result.qualifiers = {
      ...qualifiers,
      condition: values.condition.trim() || null,
    };
  return result;
}
