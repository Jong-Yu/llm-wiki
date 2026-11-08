import type { JSX } from 'react';
import type { CleanupItem } from '@contracts/ontologyCleanup.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import {
  displayValue,
  predicateText,
  valueObject,
} from '../model/buildOntologyGraph';
import { ontologyEndpointLabel } from '../model/ontologyLabels';
import styles from './OntologyCleanupPage.module.scss';

type OntologyCleanupItemProps = {
  item: CleanupItem;
  judgment?: KnowledgeValue;
  titleId?: string;
  checkboxId?: string;
  kindId?: string;
};
const decisions: Record<string, string> = {
  reject: '반려',
  defer: '보류',
  accept: '수용',
  edit: '정정',
  unreviewed: '미검토',
};
const modalities: Record<string, string> = {
  asserted: '명시된 주장',
  planned: '계획',
  possible: '가능성',
  capability: '능력',
  hypothetical: '가정',
};

/** 정리 대상의 원래 주장·한정어·인용·판단 이유를 보존해 표시합니다. */
export function OntologyCleanupItem({
  item,
  judgment,
  titleId,
  checkboxId,
  kindId,
}: OntologyCleanupItemProps): JSX.Element {
  const claim = valueObject(item.target.claim) || {};
  const entities = Array.isArray(item.target.entities)
    ? item.target.entities
    : [];
  const evidence = valueObject(claim.evidence);
  const quote =
    typeof claim.evidence === 'string' ? claim.evidence : evidence?.quote;
  const qualifiers = valueObject(claim.qualifiers);
  const candidate = item.collection === 'relation_candidates';
  const title = `${ontologyEndpointLabel(claim.subject, entities)} → ${predicateText(claim.predicate)} → ${ontologyEndpointLabel(claim.object, entities)}`;
  return (
    <div className={styles.itemContent}>
      <strong id={titleId}>
        {checkboxId ? (
          <label className={styles.itemTitle} htmlFor={checkboxId}>
            {title}
          </label>
        ) : (
          title
        )}
      </strong>
      <span id={kindId}>
        {candidate ? '연결 후보' : '관계'} ·{' '}
        {item.kind === 'archive_rejected'
          ? '현재 버전 · 반려'
          : `이전 버전 · ${decisions[item.decision] || '기존 판단'} (당시 판단)`}
      </span>
      <details>
        <summary>유지되는 근거와 판단</summary>
        <p>
          {item.kind === 'archive_rejected'
            ? '명시적으로 반려된 항목을 현재 목록에서 정리합니다.'
            : '원문 또는 추출이 바뀌어 현재 적용되지 않는 검토를 정리합니다.'}
        </p>
        {quote ? (
          <blockquote>{displayValue(quote)}</blockquote>
        ) : (
          <p>저장된 원문 인용이 없습니다. 반려을 새로 판단하지 않습니다.</p>
        )}
        {qualifiers && (
          <dl>
            {typeof qualifiers.modality === 'string' && (
              <>
                <dt>{candidate ? '후보의 표현' : '원문의 표현'}</dt>
                <dd>
                  {candidate && qualifiers.modality === 'asserted'
                    ? '제안된 주장'
                    : modalities[qualifiers.modality] || qualifiers.modality}
                </dd>
              </>
            )}
            {qualifiers.polarity && (
              <>
                <dt>긍정·부정</dt>
                <dd>{qualifiers.polarity === 'negative' ? '부정' : '긍정'}</dd>
              </>
            )}
            {(['condition', 'scope', 'time'] as const).map(
              (key: 'condition' | 'scope' | 'time'): JSX.Element | null =>
                qualifiers[key] == null ? null : (
                  <div key={key}>
                    <dt>
                      {{ condition: '조건', scope: '범위', time: '시점' }[key]}
                    </dt>
                    <dd>{displayValue(qualifiers[key])}</dd>
                  </div>
                ),
            )}
          </dl>
        )}
        {claim.reason != null && (
          <p>후보 제안 이유: {displayValue(claim.reason)}</p>
        )}
        {claim.question != null && (
          <p>검토 질문: {displayValue(claim.question)}</p>
        )}
        {judgment?.reason != null && (
          <p>판단 이유: {displayValue(judgment.reason)}</p>
        )}
        <p>원문·원시 주장·인용·전문가 판단과 과거 이력은 유지됩니다.</p>
      </details>
    </div>
  );
}
