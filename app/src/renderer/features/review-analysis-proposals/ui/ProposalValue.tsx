import type { JSX } from 'react';
import type { KnowledgeJson } from '@contracts/knowledge.contract';

type ProposalValueProps = { value: KnowledgeJson };
const fieldLabels: Record<string, string> = {
  label: '이름',
  type: '종류',
  description: '설명',
  context: '맥락',
  domain: '업무 영역',
  viewpoints: '관점',
  evidence: '원문 근거',
  quote: '인용',
  start_line: '시작 행',
  end_line: '끝 행',
  identifiers: '원문 식별자',
  namespace: '식별 범위',
  value: '값',
  qualifiers: '한정 조건',
  conditions: '조건',
  condition: '조건',
  polarity: '긍정·부정',
  modality: '가능성·의무',
  certainty: '확실성',
  confidence: '신뢰도',
  temporal: '시점',
  reason: '이유',
  provenance: '출처',
  source_entity: '출처 문서',
  attributed_to: '발언·판단 주체',
  basis: '출처 근거',
  mapping: '대응 범위',
  within: '대응하는 개념',
  subject_cardinality: '주체의 수',
  object_cardinality: '대상의 수',
  datatype: '값의 종류',
  unit: '단위',
  question: '확인 질문',
  scope: '적용 범위',
  time: '시점',
  document: '문서',
  warnings: '경고',
  omissions: '누락',
  unread_ranges: '미독 범위',
};

/** 실제 업무 값의 중첩 구조를 읽을 수 있게 표시하며 값이나 원문 키를 생략하지 않습니다. */
export function ProposalValue({ value }: ProposalValueProps): JSX.Element {
  if (value === null) return <span>값 없음</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((item: KnowledgeJson, index: number): JSX.Element => (
          <li key={index}>
            <ProposalValue value={item} />
          </li>
        ))}
      </ul>
    ) : (
      <span>없음</span>
    );
  if (typeof value === 'object')
    return (
      <dl>
        {Object.entries(value).map(
          ([key, item]: [string, KnowledgeJson]): JSX.Element => (
            <div key={key}>
              <dt>{fieldLabels[key] ?? key}</dt>
              <dd>
                <ProposalValue value={item} />
              </dd>
            </div>
          ),
        )}
      </dl>
    );
  if (typeof value === 'boolean') return <span>{value ? '예' : '아니요'}</span>;
  return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>;
}
