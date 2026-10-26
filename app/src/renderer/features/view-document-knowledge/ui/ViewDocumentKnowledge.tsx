import { useState } from 'react';
import type { JSX } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { Tabs } from '@renderer/shared/ui/Tabs';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import { useDocumentKnowledge } from '../model/useDocumentKnowledge';
import { knowledgeStatusLabel } from '../model/knowledgePresentation';
import { KnowledgeEntries } from './KnowledgeEntries';
import type { KnowledgeLayer } from './KnowledgeEntries';
import { KnowledgeRecords } from './KnowledgeRecords';
import { KnowledgeValues } from './KnowledgeValues';
import styles from './ViewDocumentKnowledge.module.scss';
import type { KnowledgeReviewSelection } from './knowledgeReview.types';

export type ViewDocumentKnowledgeProps = {
  document: string;
  connectionId: string;
  scope: {
    userId: string;
    tenant: string;
    profileId: string;
    policyRevision: string;
    domain?: string | null;
    viewpoint?: string | null;
  };
  onScopeInvalidated: () => void;
  onReview?: (selection: KnowledgeReviewSelection) => void;
};
type KnowledgeSnapshotProps = {
  data: DocumentKnowledge;
  onReview?: (selection: KnowledgeReviewSelection) => void;
};

/** 같은 응답 판본 안에서만 탭/선택을 유지하며 원문·그래프·검토 판본을 구분합니다. */
function KnowledgeSnapshot({
  data,
  onReview,
}: KnowledgeSnapshotProps): JSX.Element {
  const [layer, setLayer] = useState<KnowledgeLayer | 'history'>('claims');
  const effective = data.effectiveGraph;
  const counts = [
    { label: '개체', count: effective.entities.length },
    { label: '관계', count: effective.relations.length },
    { label: '속성', count: effective.attributes.length },
    { label: '연결 후보', count: effective.relation_candidates.length },
  ];
  return (
    <>
      {data.status !== 'ready' && (
        <StatusNotice tone="warning" title={knowledgeStatusLabel(data.status)}>
          현재 원문과 저장된 지식의 상태를 확인해 주세요. 표시된 과거 근거를
          최신 원문의 검토 결과로 사용하지 않습니다.
        </StatusNotice>
      )}
      {data.needsReview && (
        <StatusNotice tone="warning" title="검토가 필요한 지식이 있습니다">
          미검토·보류·후보와 과거 판단을 구분해 확인해 주세요.
        </StatusNotice>
      )}
      <div className={styles.summary} aria-label="유효 지식 요약">
        {counts.map((item: { label: string; count: number }): JSX.Element => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.count}</strong>
          </div>
        ))}
      </div>
      <Tabs
        label="지식 조회 구분"
        value={layer}
        onValueChange={(value: string): void => {
          if (
            value === 'claims' ||
            value === 'effective' ||
            value === 'machine' ||
            value === 'history'
          )
            setLayer(value);
        }}
        items={[
          {
            id: 'claims',
            label: `원문 주장 ${data.claims.length}`,
            content: (
              <KnowledgeEntries
                key={`${data.stateRevision}:claims`}
                data={data}
                layer="claims"
                onReview={onReview}
              />
            ),
          },
          {
            id: 'effective',
            label: '현재 유효 지식',
            content: (
              <KnowledgeEntries
                key={`${data.stateRevision}:effective`}
                data={data}
                layer="effective"
              />
            ),
          },
          {
            id: 'machine',
            label: '기계 추출',
            content: (
              <KnowledgeEntries
                key={`${data.stateRevision}:machine`}
                data={data}
                layer="machine"
              />
            ),
          },
          {
            id: 'history',
            label: '검토·판단 이력',
            content: <KnowledgeRecords data={data} />,
          },
        ]}
      />
      <details className={styles.revisionDetails}>
        <summary>조회 관점과 판본 정보</summary>
        <dl className={styles.revisions}>
          <dt>문서</dt>
          <dd>{data.document}</dd>
          <dt>원문 판본</dt>
          <dd>{data.sourceRevision}</dd>
          <dt>그래프 판본</dt>
          <dd>{data.graphRevision || '없음'}</dd>
          <dt>검토 판본</dt>
          <dd>{data.reviewRevision || '없음'}</dd>
          <dt>상태 판본</dt>
          <dd>{data.stateRevision}</dd>
          <dt>이력 판본</dt>
          <dd>{data.historyRevision}</dd>
        </dl>
        <KnowledgeValues value={data.selection} />
      </details>
    </>
  );
}

/** 저장된 지식 조회만 실행하며 선택/권한 변경 뒤의 이전 응답은 model에서 버립니다. */
export function ViewDocumentKnowledge(
  props: ViewDocumentKnowledgeProps,
): JSX.Element {
  const model = useDocumentKnowledge(props);
  return (
    <section
      className={styles.knowledge}
      aria-label="연결된 지식"
      aria-busy={model.state.status === 'loading'}
    >
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>저장된 결과</p>
          <h2>본문에서 발견한 지식</h2>
        </div>
        <Button
          variant="secondary"
          disabled={model.state.status === 'loading'}
          onClick={model.refresh}
        >
          지식 새로고침
        </Button>
      </header>
      {model.state.status === 'loading' ? (
        <StatusNotice title="연결된 지식을 불러오고 있습니다">
          선택 문서에 저장된 개념·관계와 검토 상태를 확인합니다.
        </StatusNotice>
      ) : model.state.status === 'error' ? (
        <StatusNotice tone="error" title="연결된 지식을 불러오지 못했습니다">
          <p>{model.state.error.message}</p>
          {model.state.error.traceId && (
            <p>문의 코드: {model.state.error.traceId}</p>
          )}
        </StatusNotice>
      ) : (
        <KnowledgeSnapshot
          key={model.state.data.stateRevision}
          data={model.state.data}
          onReview={props.onReview}
        />
      )}
    </section>
  );
}
