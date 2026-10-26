import { useState } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import type { JSX } from 'react';
import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeEntity,
  KnowledgeGraph,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import {
  claimContextGroup,
  claimDecisionLabel,
  claimEvidence,
  claimTitle,
  valueString,
  valueTitle,
} from '../model/knowledgePresentation';
import { KnowledgeValues } from './KnowledgeValues';
import styles from './ViewDocumentKnowledge.module.scss';
import type { KnowledgeReviewSelection } from './knowledgeReview.types';

export type KnowledgeLayer = 'claims' | 'effective' | 'machine';
type KnowledgeEntriesProps = {
  data: DocumentKnowledge;
  layer: KnowledgeLayer;
  onReview?: (selection: KnowledgeReviewSelection) => void;
};
type KnowledgeEntry = {
  key: string;
  title: string;
  kind: string;
  status: string;
  context: string;
  value: KnowledgeValue;
  original: KnowledgeValue | null;
  raw: KnowledgeValue;
  location: string;
  selection: KnowledgeReviewSelection | null;
};
type EntryDetailsProps = {
  entry: KnowledgeEntry;
  data: DocumentKnowledge;
  onReview?: (selection: KnowledgeReviewSelection) => void;
};
type EntityListProps = { entities: KnowledgeEntity[] };
const collectionLabels: Record<string, string> = {
  relations: '관계',
  attributes: '속성',
  relation_candidates: '연결 후보',
};
const contextLabels: Record<string, string> = {
  focus: '선택 관점',
  other_context: '다른 관점',
  unclassified: '관점 미분류',
};

/** 원문 주장은 거절·보류를 포함한 실제 검토 상태와 원래 값을 그대로 유지합니다. */
function sourceEntries(data: DocumentKnowledge): KnowledgeEntry[] {
  return data.claims.map(
    (claim: KnowledgeClaim, index: number): KnowledgeEntry => ({
      // 모호한 claim_id가 중복돼도 각 원시 항목을 별도로 읽을 수 있게 합니다.
      key: `${claim.claim_id}:${index}`,
      title: claimTitle(claim, data),
      kind: collectionLabels[claim.collection] || claim.collection,
      status: claim.ambiguous
        ? '식별이 모호함'
        : claimDecisionLabel(claim.decision),
      context: contextLabels[claimContextGroup(claim, data)] || '관점 미분류',
      value: claim.reviewed_value,
      original: claim.value,
      raw: claim,
      location: `claim_id: ${claim.claim_id} · claims[${index}]`,
      selection: {
        document: data.document,
        claimId: claim.claim_id,
        stateRevision: data.stateRevision,
        collection: claim.collection,
        value: claim.value,
        reviewedValue: claim.reviewed_value,
        title: claimTitle(claim, data),
        ambiguous: claim.ambiguous,
      },
    }),
  );
}

/** 그래프 배열 위치는 이번 판본의 조회 참조이며 검토/수정 ID로 사용하지 않습니다. */
function graphEntries(
  graph: KnowledgeGraph,
  layer: KnowledgeLayer,
): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  for (const collection of ['relations', 'attributes', 'relation_candidates']) {
    const values =
      collection === 'relations'
        ? graph.relations
        : collection === 'attributes'
          ? graph.attributes
          : graph.relation_candidates;
    values.forEach((value: KnowledgeValue, index: number): void => {
      entries.push({
        key: `${collection}:${index}`,
        title: valueTitle(value, graph),
        kind: collectionLabels[collection] || collection,
        status:
          collection === 'relation_candidates'
            ? '후보 · 확정 아님'
            : layer === 'machine'
              ? '기계 추출값'
              : graph.status === 'ready'
                ? '현재 유효값'
                : '저장된 값 · 최신 원문 미확인',
        context: '',
        value,
        original: null,
        raw: value,
        location: `${collection}[${index}]`,
        selection: null,
      });
    });
  }
  return entries;
}

/** 인용문과 줄 번호는 서버 값만 표시하고 정책 판단에 가짜 원문 인용을 붙이지 않습니다. */
function EntryDetails({
  entry,
  data,
  onReview,
}: EntryDetailsProps): JSX.Element {
  const evidence = claimEvidence(entry.value);
  const graphSource = valueString(data.machineGraph, 'source_revision');
  return (
    <section className={styles.inspector} aria-label="선택 지식의 근거">
      <p className={styles.eyebrow}>근거와 조건</p>
      <h3>{entry.title}</h3>
      <div className={styles.badges}>
        <span className={styles.badge}>{entry.kind}</span>
        <span className={styles.badge}>{entry.status}</span>
        {entry.context && <span className={styles.badge}>{entry.context}</span>}
      </div>
      {entry.selection && onReview && (
        <Button
          variant="secondary"
          disabled={entry.selection.ambiguous || data.status !== 'ready'}
          onClick={(): void => {
            if (entry.selection) onReview(entry.selection);
          }}
        >
          원문 대조·판단
        </Button>
      )}
      <div className={styles.evidence}>
        <h4>원문 인용</h4>
        {evidence ? (
          <>
            <blockquote>{evidence.quote}</blockquote>
            {evidence.startLine !== null && (
              <p>
                {evidence.startLine}
                {evidence.endLine !== null &&
                evidence.endLine !== evidence.startLine
                  ? `–${evidence.endLine}`
                  : ''}
                줄
              </p>
            )}
          </>
        ) : (
          <p className={styles.muted}>이 항목에는 원문 인용이 없습니다.</p>
        )}
        <p className={styles.muted}>{data.document}</p>
        <details>
          <summary>인용 기준 판본</summary>
          <dl className={styles.revisions}>
            <dt>그래프 기준 원문</dt>
            <dd>{graphSource || '미제공'}</dd>
            <dt>현재 원문</dt>
            <dd>{data.sourceRevision}</dd>
            <dt>그래프 판본</dt>
            <dd>{data.graphRevision || '미제공'}</dd>
            <dt>조회 참조</dt>
            <dd>{entry.location}</dd>
          </dl>
        </details>
      </div>
      <section className={styles.qualifiers}>
        <h4>주장 전체와 한정 조건</h4>
        <KnowledgeValues value={entry.value} />
      </section>
      {entry.original && (
        <details className={styles.details}>
          <summary>기계 추출 당시 값</summary>
          <KnowledgeValues value={entry.original} />
        </details>
      )}
      <details className={styles.details}>
        <summary>저장된 항목 상세</summary>
        <KnowledgeValues value={entry.raw} />
      </details>
    </section>
  );
}

/** 개체의 이름·유형을 요약하고 식별자/출처를 포함한 실제 상세를 펼쳐 읽습니다. */
function EntityList({ entities }: EntityListProps): JSX.Element {
  return (
    <details className={styles.entities}>
      <summary>개체 {entities.length}개</summary>
      <div className={styles.entityGrid}>
        {entities.map((entity: KnowledgeEntity): JSX.Element => (
          <details key={entity.id}>
            <summary>
              <strong>{entity.label}</strong>
              <span>{entity.type}</span>
            </summary>
            <KnowledgeValues value={entity} />
          </details>
        ))}
      </div>
    </details>
  );
}

/** 기계층·유효층·원문 검토 목록을 명시적으로 나눠 선택한 지식의 근거를 읽습니다. */
export function KnowledgeEntries({
  data,
  layer,
  onReview,
}: KnowledgeEntriesProps): JSX.Element {
  const graph = layer === 'effective' ? data.effectiveGraph : data.machineGraph;
  const entries =
    layer === 'claims' ? sourceEntries(data) : graphEntries(graph, layer);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    entries[0]?.key || null,
  );
  const selected = entries.find(
    (entry: KnowledgeEntry): boolean => entry.key === selectedKey,
  );
  return (
    <div className={styles.entries}>
      <p className={styles.layerNote}>
        {layer === 'claims'
          ? '원문 주장의 검토 상태를 표시합니다. 거절·보류된 주장도 기록에서 확인할 수 있습니다.'
          : layer === 'effective'
            ? '현재 관점의 검토·업무 판단을 반영한 서버 결과입니다. 포함된 미검토 주장이나 후보가 승인됐다는 뜻은 아닙니다.'
            : 'AI가 추출한 원래 값입니다. 전문가 검토·업무 판단이 적용된 값과 구분합니다.'}
      </p>
      <EntityList entities={graph.entities} />
      {entries.length === 0 ? (
        <p className={styles.empty}>이 목록에 표시할 저장된 지식이 없습니다.</p>
      ) : (
        <div className={styles.entryLayout}>
          <div
            className={styles.claimList}
            role="list"
            aria-label={`${layer === 'claims' ? '원문 주장' : layer === 'effective' ? '유효 지식' : '기계 추출'} 목록`}
          >
            {entries.map((entry: KnowledgeEntry): JSX.Element => (
              <div key={entry.key} role="listitem">
                <button
                  type="button"
                  className={styles.claim}
                  aria-pressed={entry.key === selectedKey}
                  onClick={(): void => setSelectedKey(entry.key)}
                >
                  <span className={styles.claimKind}>{entry.kind}</span>
                  <strong>{entry.title}</strong>
                  <span className={styles.claimMeta}>
                    {entry.status}
                    {entry.context ? ` · ${entry.context}` : ''}
                  </span>
                </button>
              </div>
            ))}
          </div>
          {selected && (
            <EntryDetails entry={selected} data={data} onReview={onReview} />
          )}
        </div>
      )}
    </div>
  );
}
