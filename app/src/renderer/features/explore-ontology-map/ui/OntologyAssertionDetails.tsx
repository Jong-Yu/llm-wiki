import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { documentEvidenceLink } from '@renderer/shared/lib/documentEvidence';
import type { JSX } from 'react';
import { Link, useLocation } from 'react-router';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { OntologyValue } from './OntologyValue';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { valueObject } from '../model/buildOntologyGraph';
import type { MapAssertion } from '../model/ontologyMap.types';
import styles from './OntologyMapWorkspace.module.scss';
import {
  ontologyEndpointLabel,
  ontologyProvenanceValue,
  ontologyValueLabel,
} from '../model/ontologyLabels';

type OntologyAssertionDetailsProps = {
  assertion: MapAssertion;
  section?: 'all' | 'summary' | 'information' | 'evidence' | 'context';
  headingLevel?: 2 | 3;
};
const labels: Record<string, string> = {
  polarity: '긍정·부정',
  modality: '표현',
  condition: '조건',
  scope: '범위',
  time: '시점',
  domain: '업무 영역',
  viewpoints: '서술 관점',
  unit: '단위',
  datatype: '값 형식',
  mapping: '대응 기준',
  start_line: '시작 행',
  end_line: '끝 행',
  occurrence: '원문 출현 순서',
  reason: '후보 사유',
  question: '확인할 질문',
  provenance: '출처와 귀속',
};
const decisions: Record<string, string> = {
  unreviewed: '미검토',
  accept: '원문 대조 확인',
  edit: '원문 근거 정정',
  reject: '거절',
  defer: '보류',
  policy: '업무 판단',
  past: '과거 기록 · 현재 미적용',
};

/** 구조화된 한정어를 숨기지 않고 원문 필드 그대로 표시합니다. */
type FieldsProps = { value: KnowledgeValue };

/** 상세 한정어 필드를 같은 순서로 표현합니다. */
function Fields({ value }: FieldsProps): JSX.Element {
  return (
    <dl className={styles.fields}>
      {Object.entries(value).map(
        ([key, item]: [string, KnowledgeJson]): JSX.Element => (
          <div key={key}>
            <dt>{labels[key] || key}</dt>
            <dd>
              {Array.isArray(item) && item.length === 0 ? (
                '없음'
              ) : (
                <OntologyValue value={item} field={key} />
              )}
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

/** 현재 주장과 원문 인용·Action log를 구별하여 선택한 관계의 근거를 보여 줍니다. */
export function OntologyAssertionDetails({
  assertion,
  section = 'all',
  headingLevel = 3,
}: OntologyAssertionDetailsProps): JSX.Element {
  const location = useLocation();
  const { value, knowledge, claim } = assertion;
  const subject = ontologyEndpointLabel(
    value.subject,
    knowledge.effectiveGraph.entities,
  );
  const object =
    value.object !== undefined
      ? ontologyEndpointLabel(value.object, knowledge.effectiveGraph.entities)
      : ontologyValueLabel(value.value);
  const qualifiers = valueObject(value.qualifiers);
  const context = valueObject(value.context);
  const evidence = valueObject(value.evidence);
  const quote =
    typeof value.evidence === 'string'
      ? value.evidence
      : typeof evidence?.quote === 'string'
        ? evidence.quote
        : null;
  const evidenceLocation = evidence
    ? Object.fromEntries(
        Object.entries(evidence).filter(
          ([key]: [string, KnowledgeJson]): boolean =>
            !['quote', 'status'].includes(key),
        ),
      )
    : null;
  const isPolicy = claim?.decision === 'policy';
  const provenance = ontologyProvenanceValue(
    value.provenance,
    knowledge.effectiveGraph.entities,
  );
  const additional = Object.fromEntries(
    Object.entries(value).filter(
      ([key]: [string, KnowledgeJson]): boolean =>
        ![
          'id',
          'claim_id',
          'status',
          'provenance',
          'subject',
          'predicate',
          'object',
          'property',
          'value',
          'qualifiers',
          'context',
          'evidence',
          'unit',
          'datatype',
          'mapping',
          'reason',
          'question',
        ].includes(key),
    ),
  );
  const valueDetails = Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]: [string, KnowledgeJson]): boolean =>
        ['datatype', 'unit', 'mapping', 'reason', 'question'].includes(key) &&
        item != null,
    ),
  );
  return (
    <>
      {(section === 'all' || section === 'summary') && (
        <div className={styles.assertionSummary}>
          <p className={styles[assertion.origin]}>
            {claim?.authored_kind === 'source'
              ? '━ 원문 근거 추가 · 추가 관계'
              : assertion.origin === 'candidate'
                ? '┄ 연결 후보 · 미확정'
                : assertion.origin === 'expert'
                  ? '━ 검토·판단 반영'
                  : '━ AI 추출 · 원문 근거'}
          </p>
          <div className={styles.phrase}>
            <strong>{subject}</strong>
            <span>
              <Icon name="arrow-right" size={14} /> {assertion.label}
            </span>
            <strong>{object}</strong>
          </div>
          <p className={styles.muted}>
            {documentDisplayName(assertion.document)} ·{' '}
            {claim
              ? decisions[claim.decision] || claim.decision
              : '판단 대상 없음'}
          </p>
        </div>
      )}
      {(section === 'all' || section === 'information') &&
        assertion.collection === 'attributes' && (
          <WorkspaceSection title="속성 값" headingLevel={headingLevel}>
            <OntologyValue value={value.value} />
          </WorkspaceSection>
        )}
      {(section === 'all' ||
        section === 'information' ||
        section === 'evidence') && (
        <WorkspaceSection
          title={isPolicy ? '업무 판단 근거' : '원문 근거'}
          headingLevel={headingLevel}
          className={styles.evidence}
        >
          {isPolicy ? (
            <>
              <p>
                원문 사실과 구분해 기록한 업무 판단입니다. 작성 주체와 이유는
                검토 기록에서 확인할 수 있습니다.
              </p>
            </>
          ) : quote ? (
            <blockquote tabIndex={section === 'evidence' ? 0 : undefined}>
              {quote}
            </blockquote>
          ) : (
            <p>이 주장에는 확인 가능한 원문 인용이 없습니다.</p>
          )}
          {!isPolicy &&
            evidenceLocation &&
            Object.keys(evidenceLocation).length > 0 && (
              <Fields value={evidenceLocation} />
            )}
          <Link
            {...documentEvidenceLink(
              assertion.document,
              knowledge.sourceRevision,
              isPolicy ? null : value.evidence,
              `${location.pathname}${location.search}`,
            )}
          >
            {documentDisplayName(assertion.document)}{' '}
            {!isPolicy && quote && '· 원문 위치 '}
            <Icon name="external-link" size={14} />
          </Link>
        </WorkspaceSection>
      )}
      {(section === 'all' ||
        section === 'information' ||
        section === 'context') && (
        <WorkspaceSection title="조건과 적용 범위" headingLevel={headingLevel}>
          {qualifiers && <Fields value={qualifiers} />}
          {context && <Fields value={context} />}
          {provenance && <Fields value={{ provenance }} />}
          {Object.keys(valueDetails).length > 0 && (
            <Fields value={valueDetails} />
          )}
          {Object.keys(additional).length > 0 && <Fields value={additional} />}
        </WorkspaceSection>
      )}
    </>
  );
}
