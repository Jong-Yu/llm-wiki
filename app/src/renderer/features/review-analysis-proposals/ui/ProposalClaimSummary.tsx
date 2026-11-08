import type { JSX } from 'react';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';

type ProposalClaimSummaryProps = {
  value: KnowledgeValue;
  graph?: KnowledgeValue | null;
};

/** 표시용 객체만 좁혀 읽고 원래 후보 데이터는 변경하지 않습니다. */
function objectValue(value: KnowledgeJson | undefined): KnowledgeValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** 관계 이름은 확정한 한국어 명사형으로 바꾸고 모르는 값은 그대로 둡니다. */
export const relationLabels: Record<string, string> = {
  uses: '사용',
  depends_on: '의존성',
  part_of: '소속',
  implements: '구현',
  related_to: '연관',
  authored_by: '작성',
  subclass_of: '하위 분류',
  instance_of: '인스턴스',
  composed_of: '포함 구성요소',
  located_in: '위치',
  has_input: '입력값',
  has_output: '출력값',
  participates_in: '참여',
  precedes: '선행',
  causes: '원인 유발',
  enables: '활성화',
  prevents: '차단',
  predicts: '예측',
  supports_prediction: '예측 근거',
  measures: '측정',
  observes: '모니터링',
  view_of: '관점',
  same_as: '동일 대상',
  different_from: '상이 대상',
  responsible_for: '담당',
  approves: '승인',
};
export type ClaimParts = { subject: string; relation: string; target: string };

/** 원문 앵커는 인용·위치를, 개체 참조는 실제 이름을 표시합니다. */
export function describeEndpoint(
  reference: KnowledgeJson | undefined,
  graph?: KnowledgeValue | null,
): string {
  const anchor = objectValue(reference);
  if (anchor?.kind === 'source_anchor' && typeof anchor.quote === 'string') {
    const location =
      typeof anchor.start_line === 'number' &&
      typeof anchor.end_line === 'number'
        ? ` · ${anchor.start_line}–${anchor.end_line}행`
        : '';
    return `${anchor.quote}${location}`;
  }
  const entities = Array.isArray(graph?.entities) ? graph.entities : [];
  const entity = entities
    .map(objectValue)
    .find((item: KnowledgeValue | null): boolean => item?.id === reference);
  return typeof entity?.label === 'string' ? entity.label : '이름 확인 필요';
}

/** 후보의 개체 참조는 이름으로 풀고 불명확한 값은 원문 인용으로 안내합니다. */
export function describeClaim(
  value: KnowledgeValue,
  graph?: KnowledgeValue | null,
): ClaimParts {
  const literal = value.value;
  const quote = objectValue(literal)?.quote;
  const target =
    value.object !== undefined
      ? describeEndpoint(value.object, graph)
      : typeof literal === 'string' ||
          typeof literal === 'number' ||
          typeof literal === 'boolean'
        ? String(literal)
        : typeof quote === 'string'
          ? quote
          : '값 확인 필요';
  const predicate = value.predicate ?? value.property;
  const relation =
    typeof predicate === 'string'
      ? (relationLabels[predicate] ?? predicate)
      : '관계';
  return { subject: describeEndpoint(value.subject, graph), relation, target };
}

/** 후보 한 줄을 "주체 · 관계 · 대상"으로 표시하며 원래 데이터는 바꾸지 않습니다. */
export function ProposalClaimSummary({
  value,
  graph,
}: ProposalClaimSummaryProps): JSX.Element {
  const { subject, relation, target } = describeClaim(value, graph);
  return (
    <span>
      {subject} · {relation} · {target}
    </span>
  );
}
