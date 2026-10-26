import type { JSX } from 'react';
import type { KnowledgeJson } from '@contracts/knowledge.contract';
import styles from './ReviewDialog.module.scss';

type ReviewStoredValueProps = { value: KnowledgeJson };
const labels: Record<string, string> = {
  subject: '주어/대상',
  predicate: '관계',
  object: '목적어',
  value: '값',
  unit: '단위',
  qualifiers: '한정 조건',
  condition: '조건',
  scope: '범위',
  time: '시점',
  context: '맥락',
  domain: '업무 영역',
  viewpoints: '관점',
  provenance: '출처',
  evidence: '원문 근거',
  quote: '인용문',
  reason: '이유',
  before: '변경 전',
  after: '변경 후',
  actor: '기록 주체',
  timestamp: '기록 시각',
  source_revision: '원문 판본',
  graph_revision: '그래프 판본',
  state_revision: '상태 판본',
};

/** 당시 기록의 필드를 생략 없이 읽되 값에 포함된 HTML/명령을 실행하지 않습니다. */
export function ReviewStoredValue({
  value,
}: ReviewStoredValueProps): JSX.Element {
  if (value === null) return <span className={styles.muted}>미지정</span>;
  if (typeof value !== 'object')
    return <span className={styles.storedText}>{String(value)}</span>;
  if (Array.isArray(value))
    return (
      <ol className={styles.storedList}>
        {value.map((item: KnowledgeJson, index: number): JSX.Element => (
          <li key={index}>
            <ReviewStoredValue value={item} />
          </li>
        ))}
      </ol>
    );
  return (
    <dl className={styles.storedFields}>
      {Object.entries(value).map(
        ([name, item]: [string, KnowledgeJson]): JSX.Element => (
          <div key={name}>
            <dt>{labels[name] || name}</dt>
            <dd>
              <ReviewStoredValue value={item} />
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}
