import { z } from 'zod';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type { CorrectionBasis } from './ontologyMap.types';
import { valueObject } from './buildOntologyGraph';

export type ReviewLeaf = {
  id: string;
  path: readonly (string | number)[];
  label: string;
  value: string;
  kind: 'text' | 'number' | 'boolean' | 'nullable' | 'viewpoints';
  primary: boolean;
};
const labels: Record<string, string> = {
  subject: '주체',
  predicate: '관계',
  object: '대상',
  property: '속성 이름',
  datatype: '값 형식',
  value: '속성 값',
  unit: '단위',
  id: '속성 ID',
  evidence: '원문 인용',
  qualifiers: '한정 조건',
  polarity: '극성',
  modality: '양태',
  condition: '조건',
  scope: '범위',
  time: '시점',
  context: '적용 맥락',
  domain: '업무 영역',
  viewpoints: '서술 관점',
  quote: '원문 구절',
  start_line: '시작 줄',
  end_line: '끝 줄',
  occurrence: '원문 출현 순서',
  provenance: '출처와 귀속',
  source_entity: '출처 문서',
  attributed_to: '발언·내용의 주체',
  basis: '귀속 근거',
};
const primaryRoots = new Set([
  'subject',
  'predicate',
  'object',
  'property',
  'datatype',
  'value',
  'unit',
  'qualifiers',
  'context',
  'evidence',
]);
export const reviewFormSchema = z.object({
  action: z.enum(['accept', 'edit', 'reject', 'defer']),
  reason: z
    .string()
    .trim()
    .min(1, '판단 이유를 입력해 주세요.')
    .max(1000, '이유는 1000자 이내로 입력해 주세요.'),
  leaves: z.record(z.string(), z.string().max(4096)),
  nulls: z.record(z.string(), z.boolean()),
});
export type ReviewFormValues = z.infer<typeof reviewFormSchema>;

/** 저장 형식의 인용 위치/status만 입력 형식으로 되돌리고 다른 의미 필드는 보존합니다. */
export function sourceInput(value: KnowledgeJson): KnowledgeJson {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item: KnowledgeJson): KnowledgeJson => sourceInput(item));
  const result: KnowledgeValue = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'status') continue;
    result[key] =
      key === 'evidence' &&
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof item.quote === 'string'
        ? item.quote
        : sourceInput(item);
  }
  return result;
}

/** 후보 정정은 후보 설명을 원문 관계의 필드로 재해석하지 않고 실제 주장만 전달합니다. */
export function reviewInput(basis: CorrectionBasis): KnowledgeValue {
  const claim = basis.assertion.claim;
  const value =
    valueObject(claim?.source_reviewed_value) ?? basis.assertion.value;
  const input = valueObject(sourceInput(value));
  if (!input) return {};
  if (claim?.collection !== 'relation_candidates') return input;
  const result: KnowledgeValue = {};
  for (const [key, item] of Object.entries(input))
    if (!['id', 'reason', 'question'].includes(key)) result[key] = item;
  return result;
}

/** 객체는 원형을 유지하고 편집할 수 있는 실제 스칼라 필드만 이름 있는 입력으로 나눕니다. */
export function reviewLeaves(value: KnowledgeJson): ReviewLeaf[] {
  const result: ReviewLeaf[] = [];
  function visit(
    current: KnowledgeJson,
    path: readonly (string | number)[],
  ): void {
    if (Array.isArray(current)) {
      if (
        path.at(-1) === 'viewpoints' &&
        current.every(
          (item: KnowledgeJson): item is string => typeof item === 'string',
        )
      ) {
        result.push({
          id: `p${result.length}`,
          path,
          label: path
            .map((part: string | number): string =>
              typeof part === 'string' ? labels[part] || part : `${part + 1}`,
            )
            .join(' · '),
          value: current.join(', '),
          kind: 'viewpoints',
          primary: true,
        });
      } else
        current.forEach((item: KnowledgeJson, index: number): void =>
          visit(item, [...path, index]),
        );
      return;
    }
    if (current !== null && typeof current === 'object') {
      for (const [key, item] of Object.entries(current))
        visit(item, [...path, key]);
      return;
    }
    result.push({
      id: `p${result.length}`,
      path,
      label: path
        .map((part: string | number): string =>
          typeof part === 'string' ? labels[part] || part : `${part + 1}`,
        )
        .join(' · '),
      value: current === null ? '' : String(current),
      kind:
        current === null
          ? 'nullable'
          : typeof current === 'number'
            ? 'number'
            : typeof current === 'boolean'
              ? 'boolean'
              : 'text',
      primary: typeof path[0] === 'string' && primaryRoots.has(path[0]),
    });
  }
  visit(value, []);
  return result;
}

/** 폼은 읽은 스칼라와 null 상태에서만 시작하며 이유/판정은 사용자가 명시합니다. */
export function initialReviewValues(leaves: ReviewLeaf[]): ReviewFormValues {
  const values: Record<string, string> = {};
  const nulls: Record<string, boolean> = {};
  for (const leaf of leaves) {
    values[leaf.id] = leaf.value;
    nulls[leaf.id] = leaf.kind === 'nullable';
  }
  return { action: 'accept', reason: '', leaves: values, nulls };
}

/** 입력에 없는 복합 필드는 원형을 유지하고 사용자에게 표시한 필드만 교체합니다. */
export function editedValue(
  base: KnowledgeJson,
  leaves: ReviewLeaf[],
  values: ReviewFormValues,
): KnowledgeJson {
  const byPath = new Map(
    leaves.map((leaf: ReviewLeaf): [string, ReviewLeaf] => [
      JSON.stringify(leaf.path),
      leaf,
    ]),
  );
  function visit(
    current: KnowledgeJson,
    path: readonly (string | number)[],
  ): KnowledgeJson {
    const leaf = byPath.get(JSON.stringify(path));
    if (leaf) {
      const value = values.leaves[leaf.id];
      if (value === undefined) return current;
      if (values.nulls[leaf.id]) return null;
      if (leaf.kind === 'number') {
        const number = Number(value);
        if (!value.trim() || !Number.isFinite(number))
          throw new Error(`${leaf.label}: 올바른 숫자를 입력해 주세요.`);
        return number;
      }
      if (leaf.kind === 'boolean') return value === 'true';
      if (leaf.kind === 'viewpoints')
        return value
          .split(',')
          .map((part: string): string => part.trim())
          .filter((part: string): boolean => part !== '');
      return value;
    }
    if (Array.isArray(current))
      return current.map((item: KnowledgeJson, index: number): KnowledgeJson =>
        visit(item, [...path, index]),
      );
    if (current !== null && typeof current === 'object') {
      const result: KnowledgeValue = {};
      for (const [key, item] of Object.entries(current))
        result[key] = visit(item, [...path, key]);
      return result;
    }
    return current;
  }
  return visit(base, []);
}

/** 전문가 판단은 원문 인용 대신 현재 관점의 완전한 업무 주장으로 입력합니다. */
export function policyInput(basis: CorrectionBasis): KnowledgeValue {
  const base = basis.assertion.value;
  const qualifiers =
    base.qualifiers !== null &&
    typeof base.qualifiers === 'object' &&
    !Array.isArray(base.qualifiers)
      ? base.qualifiers
      : {};
  const subject = typeof base.subject === 'string' ? base.subject : '';
  const core: KnowledgeValue =
    basis.assertion.collection === 'attributes'
      ? {
          id: typeof base.id === 'string' ? base.id : 'expert_attribute',
          subject,
          property: typeof base.property === 'string' ? base.property : '',
          datatype: base.datatype === 'number' ? 'number' : 'text',
          value: typeof base.value === 'string' ? base.value : '',
          unit: typeof base.unit === 'string' ? base.unit : null,
        }
      : {
          subject,
          predicate: typeof base.predicate === 'string' ? base.predicate : '',
          object: typeof base.object === 'string' ? base.object : '',
        };
  return {
    ...core,
    qualifiers: {
      polarity: qualifiers.polarity === 'negative' ? 'negative' : 'positive',
      modality:
        typeof qualifiers.modality === 'string'
          ? qualifiers.modality
          : 'asserted',
      condition:
        typeof qualifiers.condition === 'string' ? qualifiers.condition : null,
      scope: typeof qualifiers.scope === 'string' ? qualifiers.scope : null,
      time: typeof qualifiers.time === 'string' ? qualifiers.time : null,
    },
    context: {
      domain: basis.assertion.knowledge.access.domain,
      viewpoints:
        basis.assertion.knowledge.access.viewpoint === null
          ? []
          : [basis.assertion.knowledge.access.viewpoint],
    },
  };
}
