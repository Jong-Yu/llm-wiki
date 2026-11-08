import type { JSX } from 'react';
import type { KnowledgeJson } from '@contracts/knowledge.contract';
import styles from './OntologyMapWorkspace.module.scss';
import { structuredTextValue } from '../model/sourceAnchors';
import { ontologyTermLabel } from '../model/ontologyLabels';

type OntologyValueProps = {
  value: KnowledgeJson | undefined;
  depth?: number;
  field?: string;
};
const labels: Record<string, string> = {
  original_record_id: '원본 기록',
  original_sha256: '원본 SHA-256',
  original_json_schema_id: '원본 JSON 스키마',
  original_json_schema_dialect: 'JSON 스키마 방언',
  metadata_role: '메타데이터 역할',
  namespace: '이름 공간',
  value: '값',
  subject: '주체',
  predicate: '관계',
  object: '대상',
  property: '속성 이름',
  datatype: '값 형식',
  unit: '단위',
  evidence: '원문 근거',
  quote: '원문 구절',
  start_line: '시작 행',
  end_line: '끝 행',
  occurrence: '원문 출현 순서',
  qualifiers: '한정 조건',
  polarity: '긍정·부정',
  modality: '표현',
  condition: '조건',
  scope: '범위',
  time: '시점',
  context: '적용 맥락',
  domain: '업무 영역',
  viewpoint: '서술 관점',
  viewpoints: '서술 관점',
  mapping: '대응 기준',
  reason: '이유',
  question: '확인할 질문',
  provenance: '출처와 귀속',
  source_entity: '출처 문서',
  attributed_to: '발언·내용의 주체',
  basis: '귀속 근거',
};

/** 업무 값과 원문 메타데이터는 중첩 깊이에 관계없이 항목별로 읽습니다. */
export function OntologyValue({
  value,
  depth = 0,
  field,
}: OntologyValueProps): JSX.Element {
  if (value === undefined || value === null) return <span>미지정</span>;
  if (typeof value === 'string' && depth < 6) {
    const structured = structuredTextValue(value);
    if (structured !== undefined)
      return (
        <div>
          <p className={styles.muted}>JSON 형식의 텍스트</p>
          <OntologyValue value={structured} depth={depth + 1} />
        </div>
      );
  }
  if (typeof value !== 'object')
    return (
      <span className={styles.valueText}>
        {typeof value === 'string' &&
        field &&
        ['polarity', 'modality', 'viewpoint', 'viewpoints'].includes(field)
          ? ontologyTermLabel(value)
          : String(value)}
      </span>
    );
  if (depth >= 6)
    return (
      <details>
        <summary>중첩된 값 보기</summary>
        <OntologyValue value={value} />
      </details>
    );
  if (Array.isArray(value))
    return value.length === 0 ? (
      <span>없음</span>
    ) : (
      <ul className={styles.valueList}>
        {value.map((item: KnowledgeJson, index: number): JSX.Element => (
          <li key={index}>
            <OntologyValue value={item} depth={depth + 1} field={field} />
          </li>
        ))}
      </ul>
    );
  const entries = Object.entries(value);
  return entries.length === 0 ? (
    <span>빈 객체</span>
  ) : (
    <dl className={styles.valueFields}>
      {entries.map(([key, item]: [string, KnowledgeJson]): JSX.Element => (
        <div key={key}>
          <dt>{labels[key] ?? key}</dt>
          <dd>
            {typeof item === 'string' &&
            ['quote', 'evidence', 'basis'].includes(key) ? (
              <span className={styles.valueText}>{item}</span>
            ) : (
              <OntologyValue value={item} depth={depth + 1} field={key} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
