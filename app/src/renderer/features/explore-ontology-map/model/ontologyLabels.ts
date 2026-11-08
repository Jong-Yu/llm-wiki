import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { sourceAnchorLabel, structuredTextValue } from './sourceAnchors';
import { displayValue, predicateText, valueObject } from './buildOntologyGraph';

const termLabels: Record<string, string> = {
  concept: '개념',
  document: '문서',
  source_anchor: '원문 근거',
  system: '시스템',
  component: '구성 요소',
  term: '용어',
  asserted: '원문에서 서술',
  certain: '확실',
  actual: '실제',
  positive: '긍정',
  affirmative: '긍정',
  negative: '부정',
  negated: '부정',
  possible: '가능',
  probable: '개연',
  required: '필수',
  permitted: '허용',
  forbidden: '금지',
  recommended: '권고',
  developer: '개발 관점',
  business: '업무 관점',
  architecture: '아키텍처 관점',
};

/** 알려진 분류·상태만 읽기 쉬운 말로 바꾸고 원문에만 있는 분류는 유지합니다. */
export function ontologyTermLabel(value: string): string {
  return termLabels[value] ?? value;
}

/** 조건 값의 짧은 읽기 표현이며 전체 값은 관계 상세에서 확인합니다. */
function qualifierText(value: KnowledgeJson, depth: number = 0): string {
  if (value === null) return '미지정';
  if (typeof value !== 'object') return String(value);
  if (depth >= 2)
    return `${Array.isArray(value) ? value.length : Object.keys(value).length}개 항목`;
  if (Array.isArray(value))
    return value
      .map((item: KnowledgeJson): string => qualifierText(item, depth + 1))
      .join(', ');
  return Object.entries(value)
    .map(
      ([key, item]: [string, KnowledgeJson]): string =>
        `${key}: ${qualifierText(item, depth + 1)}`,
    )
    .join(' · ');
}

/** 같은 양끝을 가진 관계도 적용 조건·범위·시점·관점으로 구별합니다. */
export function ontologyQualifierSummary(value: KnowledgeValue): string {
  const qualifiers = valueObject(value.qualifiers);
  const context = valueObject(value.context);
  const labels: Record<string, string> = {
    condition: '조건',
    scope: '범위',
    time: '시점',
    domain: '업무 영역',
    viewpoints: '관점',
  };
  return Object.entries({ ...qualifiers, ...context })
    .filter(
      ([key, item]: [string, KnowledgeJson]): boolean =>
        key in labels &&
        item !== null &&
        item !== '' &&
        !(Array.isArray(item) && item.length === 0),
    )
    .map(
      ([key, item]: [string, KnowledgeJson]): string =>
        `${labels[key]}: ${key === 'viewpoints' && Array.isArray(item) ? item.map((part: KnowledgeJson): string => (typeof part === 'string' ? ontologyTermLabel(part) : qualifierText(part))).join(', ') : qualifierText(item)}`,
    )
    .join(' · ');
}

/** 구조화된 값의 요약은 목록에 쓰고 실제 값은 선택 상세에서 읽습니다. */
export function ontologyValueLabel(value: KnowledgeJson | undefined): string {
  if (typeof value === 'string') {
    const structured = structuredTextValue(value);
    if (structured !== undefined)
      return `JSON 텍스트 · ${Array.isArray(structured) ? structured.length : Object.keys(structured ?? {}).length}개 항목`;
  }
  if (Array.isArray(value)) return `값 ${value.length}개`;
  if (value !== null && typeof value === 'object')
    return `구조화된 값 · ${Object.keys(value).length}개 항목`;
  return displayValue(value);
}

/** 개체 참조를 저장된 이름·원문 앵커로 풀며 미해결 식별자는 기본 화면에 표시하지 않습니다. */
export function ontologyEndpointLabel(
  reference: KnowledgeJson | undefined,
  entities: readonly KnowledgeJson[],
): string {
  const named = entities
    .map(valueObject)
    .find((entity: KnowledgeValue | null): boolean => entity?.id === reference);
  if (typeof named?.label === 'string' && named.label.trim())
    return named.label;
  const anchor = valueObject(reference);
  if (anchor?.kind === 'source_anchor') return sourceAnchorLabel(anchor);
  if (typeof anchor?.label === 'string' && anchor.label.trim())
    return anchor.label;
  if (typeof anchor?.quote === 'string' && anchor.quote.trim())
    return anchor.quote;
  if (reference === null || reference === undefined) return '미지정 개념';
  if (
    typeof reference === 'string' &&
    /[\s\u0080-\uffff]/.test(reference) &&
    !/[a-f0-9]{24,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i.test(
      reference,
    )
  )
    return reference;
  return '이름을 확인할 개념';
}

/** 원문 귀속과 근거는 이름으로 읽고 이벤트 등 내부 처리 참조는 표시하지 않습니다. */
export function ontologyProvenanceValue(
  provenance: KnowledgeJson | undefined,
  entities: readonly KnowledgeJson[],
): KnowledgeValue | null {
  const source = valueObject(provenance);
  if (!source) return null;
  const result: KnowledgeValue = {};
  for (const key of ['source_entity', 'attributed_to'])
    if (source[key] !== undefined && source[key] !== null)
      result[key] = ontologyEndpointLabel(source[key], entities);
  if (source.basis !== undefined && source.basis !== null)
    result.basis = source.basis;
  return Object.keys(result).length > 0 ? result : null;
}

/** 표시용 관계 문장은 원래 값과 식별자를 변경하지 않고 이름만 해석합니다. */
export function ontologyClaimLabel(
  value: KnowledgeValue,
  entities: readonly KnowledgeJson[],
): string {
  const subject = ontologyEndpointLabel(value.subject, entities);
  const relation = predicateText(value.predicate ?? value.property);
  const object =
    value.object !== undefined
      ? ontologyEndpointLabel(value.object, entities)
      : ontologyValueLabel(value.value);
  return `${subject} → ${relation} → ${object}`;
}

/** 당시 기록에 포함된 개체 이름만 돌려주며 현재 그래프와 자동 합치지 않습니다. */
export function ontologyRecordedEntities(
  event: KnowledgeValue | undefined,
): readonly KnowledgeJson[] {
  const entities = valueObject(event?.target)?.entities ?? event?.entities;
  return Array.isArray(entities) ? entities : [];
}
