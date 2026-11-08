import type { JSX } from 'react';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { ProposalClaimSummary, describeEndpoint } from './ProposalClaimSummary';
import { ProposalValue } from './ProposalValue';

type ProposalGraphDetailsProps = { graph: KnowledgeValue | null };
type ProposalClaimDetailsProps = {
  value: KnowledgeValue;
  graph?: KnowledgeValue | null;
};
const collections: Record<string, string> = {
  entities: '개념',
  relations: '관계',
  attributes: '속성',
  relation_candidates: '추정 관계 후보',
};
const technicalGraphFields = new Set([
  'version',
  'schema_version',
  'source_revision',
  'source_document',
  'source_hash',
  'graph_revision',
  'document_id',
  'status',
  'entities',
  'relations',
  'attributes',
  'relation_candidates',
]);

/** 참조로 쓰인 구조 필드만 제외하며 조건·부정·근거 등 주장 본문을 모두 제공합니다. */
export function ProposalClaimDetails({
  value,
  graph,
}: ProposalClaimDetailsProps): JSX.Element {
  const meaning = Object.fromEntries(
    Object.entries(value).filter(
      ([key]: [string, KnowledgeJson]): boolean =>
        ![
          'subject',
          'object',
          'predicate',
          'property',
          'claim_id',
          'id',
          'status',
        ].includes(key),
    ),
  );
  const provenance = meaning.provenance;
  if (
    provenance !== null &&
    typeof provenance === 'object' &&
    !Array.isArray(provenance)
  )
    meaning.provenance = Object.fromEntries(
      Object.entries(provenance).map(
        ([key, item]: [string, KnowledgeJson]): [string, KnowledgeJson] => [
          key,
          ['source_entity', 'attributed_to'].includes(key) && item !== null
            ? describeEndpoint(item, graph)
            : item,
        ],
      ),
    );
  const mapping = meaning.mapping;
  if (
    mapping !== null &&
    typeof mapping === 'object' &&
    !Array.isArray(mapping) &&
    mapping.within !== undefined
  )
    meaning.mapping = {
      ...mapping,
      within: describeEndpoint(mapping.within, graph),
    };
  return (
    <div>
      <ProposalClaimSummary value={value} graph={graph} />
      <ProposalValue value={meaning} />
    </div>
  );
}

/** 전체 그래프의 업무 내용을 보존하면서 서버 판본과 개체 참조를 표시에서 제외합니다. */
export function ProposalGraphDetails({
  graph,
}: ProposalGraphDetailsProps): JSX.Element {
  if (!graph) return <p>추출 내용이 없습니다.</p>;
  const extra = Object.fromEntries(
    Object.entries(graph).filter(
      ([key]: [string, KnowledgeJson]): boolean =>
        !technicalGraphFields.has(key),
    ),
  );
  return (
    <>
      {Object.entries(collections).map(
        ([key, label]: [string, string]): JSX.Element => {
          const items = Array.isArray(graph[key]) ? graph[key] : [];
          if (items.length === 0) return <span key={key} />;
          return (
            <section key={key}>
              <h4>
                {label} · {items.length}개
              </h4>
              <ol>
                {items.map(
                  (item: KnowledgeJson, index: number): JSX.Element => {
                    if (
                      item === null ||
                      typeof item !== 'object' ||
                      Array.isArray(item)
                    )
                      return (
                        <li key={index}>
                          <ProposalValue value={item} />
                        </li>
                      );
                    const entity = Object.fromEntries(
                      Object.entries(item).filter(
                        ([field]: [string, KnowledgeJson]): boolean =>
                          field !== 'id',
                      ),
                    );
                    return (
                      <li key={index}>
                        {key === 'entities' ? (
                          <ProposalValue value={entity} />
                        ) : (
                          <ProposalClaimDetails value={item} graph={graph} />
                        )}
                      </li>
                    );
                  },
                )}
              </ol>
            </section>
          );
        },
      )}
      {Object.keys(extra).length > 0 && <ProposalValue value={extra} />}
    </>
  );
}
