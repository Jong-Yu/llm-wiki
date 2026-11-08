import type { KnowledgeValue } from '@contracts/knowledge.contract';

const labels: Record<string, string> = {
  negative: '부정',
  negated: '부정',
  possible: '가능',
  probable: '개연',
  required: '필수',
  permitted: '허용',
  forbidden: '금지',
  recommended: '권고',
};

/** 원문 한정어를 지도와 목록에 함께 남기고 알려지지 않은 값도 숨기지 않습니다. */
export function ontologyQualifications(value: KnowledgeValue | null): string[] {
  if (!value) return [];
  const flags: string[] = [];
  if (
    typeof value.polarity === 'string' &&
    !['positive', 'affirmative'].includes(value.polarity)
  )
    flags.push(labels[value.polarity] ?? value.polarity);
  if (
    typeof value.modality === 'string' &&
    !['asserted', 'certain', 'actual'].includes(value.modality)
  )
    flags.push(labels[value.modality] ?? value.modality);
  if (value.condition !== undefined && value.condition !== null)
    flags.push('조건 있음');
  return flags;
}
