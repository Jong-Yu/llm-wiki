import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeGraph,
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';

export type KnowledgeContextGroup = 'focus' | 'other_context' | 'unclassified';
export type KnowledgeEvidence = {
  quote: string;
  startLine: number | null;
  endLine: number | null;
};

/** JSON 객체는 원본을 변경하지 않고 표시할 때만 구조를 좁힙니다. */
function object(value: KnowledgeJson | undefined): KnowledgeValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** 서버 문자열 필드만 반환하고 객체를 이름이나 사실로 추측하지 않습니다. */
export function valueString(value: KnowledgeValue, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

/** 확장 필드의 원형을 상세 보기에서 보존하며 표준 주장의 의미로 바꾸지 않습니다. */
export function jsonText(value: KnowledgeJson | undefined): string {
  return value === undefined ? '정보 없음' : JSON.stringify(value, null, 2);
}

/** 참조한 개체 ID는 유효층과 기계층의 실제 label로만 풉니다. */
function entityLabel(id: string, graph: KnowledgeGraph): string {
  const entity = graph.entities.find(
    (item: KnowledgeGraph['entities'][number]): boolean => item.id === id,
  );
  return entity ? entity.label : id;
}

/** 구조화된 원문 구절 끝점은 개체 ID로 바꾸지 않고 실제 인용으로 표시합니다. */
function endpointLabel(
  value: KnowledgeJson | undefined,
  graph: KnowledgeGraph,
): string | null {
  if (typeof value === 'string') return entityLabel(value, graph);
  const details = object(value);
  if (!details) return null;
  const quote = valueString(details, 'quote');
  if (quote) return `원문 구절: ${quote}`;
  const id = valueString(details, 'id');
  return id ? entityLabel(id, graph) : null;
}

/** 관계/속성 요약은 선택한 그래프의 실제 값과 개체만 사용합니다. */
export function valueTitle(
  value: KnowledgeValue,
  graph: KnowledgeGraph,
): string {
  const subject = endpointLabel(value.subject, graph);
  const predicate = valueString(value, 'predicate');
  if (subject && predicate) {
    const target = endpointLabel(value.object, graph);
    return `${subject} → ${predicate}${target ? ` → ${target}` : ''}`;
  }
  if (subject) {
    const attribute =
      valueString(value, 'property') ||
      valueString(value, 'name') ||
      valueString(value, 'attribute') ||
      '속성';
    const amount = value.value;
    const unit = valueString(value, 'unit');
    const shown =
      typeof amount === 'string' ||
      typeof amount === 'number' ||
      typeof amount === 'boolean'
        ? String(amount)
        : '';
    return `${subject} · ${attribute}${shown ? `: ${shown}${unit ? ` ${unit}` : ''}` : ''}`;
  }
  return '저장된 주장';
}

/** 검토 주장 요약은 유효층 개체와 실제 기계층 참조를 함께 보존합니다. */
export function claimTitle(
  claim: KnowledgeClaim,
  data: DocumentKnowledge,
): string {
  const known = new Set(
    data.effectiveGraph.entities.map(
      (item: KnowledgeGraph['entities'][number]): string => item.id,
    ),
  );
  const entities = [
    ...data.effectiveGraph.entities,
    ...data.machineGraph.entities.filter(
      (item: KnowledgeGraph['entities'][number]): boolean =>
        !known.has(item.id),
    ),
  ];
  return valueTitle(claim.reviewed_value, { ...data.effectiveGraph, entities });
}

/** 실제 인용이 있을 때만 인용문으로 표시하며 전문가 판단의 근거를 발명하지 않습니다. */
export function claimEvidence(value: KnowledgeValue): KnowledgeEvidence | null {
  const evidence = value.evidence;
  if (typeof evidence === 'string')
    return { quote: evidence, startLine: null, endLine: null };
  const details = object(evidence);
  if (!details || typeof details.quote !== 'string') return null;
  return {
    quote: details.quote,
    startLine:
      typeof details.start_line === 'number' ? details.start_line : null,
    endLine: typeof details.end_line === 'number' ? details.end_line : null,
  };
}

/** 태그 없는 주장을 공통 사실로 승격하지 않고 서버와 같은 세 관점 그룹으로 표시합니다. */
export function claimContextGroup(
  claim: KnowledgeClaim,
  data: DocumentKnowledge,
): KnowledgeContextGroup {
  const context = object(claim.reviewed_value.context);
  const domain = context?.domain;
  const viewpoints = context?.viewpoints;
  const tags = Array.isArray(viewpoints)
    ? viewpoints.filter(
        (value: KnowledgeJson): value is string => typeof value === 'string',
      )
    : [];
  const selectedDomain = data.access.domain;
  const selectedViewpoint = data.access.viewpoint;
  if (
    (selectedDomain !== null && (domain === null || domain === undefined)) ||
    (selectedViewpoint !== null && tags.length === 0) ||
    (selectedDomain === null &&
      selectedViewpoint === null &&
      (domain === null || domain === undefined) &&
      tags.length === 0)
  )
    return 'unclassified';
  return (selectedDomain === null || selectedDomain === domain) &&
    (selectedViewpoint === null || tags.includes(selectedViewpoint))
    ? 'focus'
    : 'other_context';
}

/** 원문 검토와 업무 판단은 각각의 서버 decision을 그대로 구분합니다. */
export function claimDecisionLabel(decision: string): string {
  const labels: Record<string, string> = {
    unreviewed: '미검토',
    accept: '원문 대조 확인',
    edit: '원문 근거 정정',
    reject: '거절',
    defer: '보류',
    policy: '전문가 업무 판단',
  };
  return labels[decision] || decision;
}

/** 그래프의 현재성과 추출 부재/손상을 조회 실패와 구분해 표시합니다. */
export function knowledgeStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ready: '현재 본문의 저장 지식',
    stale: '본문 변경 후 재확인 필요',
    missing: '아직 저장된 지식이 없습니다',
    unavailable: '저장 지식 확인 불가',
  };
  return labels[status] || status;
}
