import type { JSX } from 'react';
import type { KnowledgeJson } from '@contracts/knowledge.contract';
import styles from './ViewDocumentKnowledge.module.scss';

type KnowledgeValuesProps = { value: KnowledgeJson };
const labels: Record<string, string> = {
  qualifiers: '한정 조건',
  polarity: '극성',
  modality: '양태',
  condition: '조건',
  scope: '범위',
  time: '시점',
  context: '업무 맥락',
  domain: '업무 영역',
  viewpoints: '관점',
  provenance: '출처',
  attributed_to: '진술 주체',
  source_entity: '출처 개체',
  basis: '근거 종류',
  mapping: '대응 조건',
  evidence: '원문 근거',
  quote: '인용문',
  start_line: '시작 줄',
  end_line: '끝 줄',
  identifiers: '식별자',
  namespace: '발급 범위',
  unit: '단위',
  reason: '이유',
  question: '확인이 필요한 질문',
  before: '변경 전',
  after: '변경 후',
  actor: '기록 주체',
  source_revision: '원문 판본',
  graph_revision: '그래프 판본',
  state_revision: '상태 판본',
  history_revision: '이력 판본',
};

/** 실제 JSON 필드를 구조대로 읽어 보여 주며 알려지지 않은 필드도 생략하지 않습니다. */
export function KnowledgeValues({ value }: KnowledgeValuesProps): JSX.Element {
  if (value === null) return <span className={styles.muted}>미지정</span>;
  if (typeof value === 'string')
    return (
      <span className={styles.storedText}>
        {value === '' ? '(빈 문자열)' : value}
      </span>
    );
  if (typeof value === 'number' || typeof value === 'boolean')
    return <span>{String(value)}</span>;
  if (Array.isArray(value))
    return value.length === 0 ? (
      <span className={styles.muted}>항목 없음</span>
    ) : (
      <ol className={styles.storedList}>
        {value.map((item: KnowledgeJson, index: number): JSX.Element => (
          <li key={index}>
            <KnowledgeValues value={item} />
          </li>
        ))}
      </ol>
    );
  const fields = Object.entries(value);
  if (fields.length === 0)
    return <span className={styles.muted}>필드 없음</span>;
  return (
    <dl className={styles.storedFields}>
      {fields.map(([key, item]: [string, KnowledgeJson]): JSX.Element => (
        <div key={key}>
          <dt>{labels[key] || key}</dt>
          <dd>
            <KnowledgeValues value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
