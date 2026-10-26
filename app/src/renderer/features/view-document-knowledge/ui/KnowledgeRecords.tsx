import type { JSX } from 'react';
import type {
  DocumentKnowledge,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { valueString } from '../model/knowledgePresentation';
import { KnowledgeValues } from './KnowledgeValues';
import styles from './ViewDocumentKnowledge.module.scss';

type KnowledgeRecordsProps = { data: DocumentKnowledge };
const policyLabels: Record<string, string> = {
  active: '현재 관점에 적용',
  other_scope: '다른 관점의 판단',
  pending: '과거 근거 · 재확인 대기',
  inactive: '비활성',
};
const actionLabels: Record<string, string> = {
  accept: '원문 검토 수용',
  edit: '원문 근거 정정',
  reject: '원문 주장 거절',
  defer: '검토 보류',
  undo: '검토 되돌림',
  policy: '전문가 업무 판단',
  policy_undo: '업무 판단 되돌림',
};

/** 업무 판단은 원문 검토와 구분하고 적용 범위/이벤트 근거를 그대로 보존합니다. */
export function KnowledgeRecords({ data }: KnowledgeRecordsProps): JSX.Element {
  return (
    <div className={styles.records}>
      <section>
        <div className={styles.sectionHeading}>
          <h3>전문가 업무 판단</h3>
          <span>{data.policies.length}개</span>
        </div>
        <p className={styles.muted}>
          업무 판단의 근거는 기록된 이벤트입니다. 원문 인용에 대한 검토와
          구분합니다.
        </p>
        {data.policies.length === 0 ? (
          <p className={styles.empty}>저장된 업무 판단이 없습니다.</p>
        ) : (
          data.policies.map(
            (policy: KnowledgeValue, index: number): JSX.Element => {
              const status = valueString(policy, 'status');
              const eventId = valueString(policy, 'event_id');
              return (
                <details className={styles.record} key={eventId || index}>
                  <summary>
                    <strong>
                      {status
                        ? policyLabels[status] || status
                        : '판단 상태 미제공'}
                    </strong>
                    <span>{eventId || '이벤트 정보'}</span>
                  </summary>
                  <KnowledgeValues value={policy} />
                </details>
              );
            },
          )
        )}
      </section>
      <section>
        <div className={styles.sectionHeading}>
          <h3>검토·판단 이력</h3>
          <span>{data.history.length}개</span>
        </div>
        {data.pendingHistory.length > 0 && (
          <p className={styles.pending}>
            현재 근거에 자동 적용하지 않는 과거 이력{' '}
            {data.pendingHistory.length}개가 있습니다.
          </p>
        )}
        {data.history.length === 0 ? (
          <p className={styles.empty}>저장된 검토·판단 이력이 없습니다.</p>
        ) : (
          [...data.history]
            .reverse()
            .map((event: KnowledgeValue, index: number): JSX.Element => {
              const id = valueString(event, 'id');
              const action = valueString(event, 'action');
              const reason = valueString(event, 'reason');
              const pending = id !== null && data.pendingHistory.includes(id);
              return (
                <details className={styles.record} key={id || index}>
                  <summary>
                    <strong>
                      {action ? actionLabels[action] || action : '이벤트'}
                      {pending ? ' · 과거 근거/대기' : ''}
                    </strong>
                    <span>{reason || id || '상세 기록 보기'}</span>
                  </summary>
                  <KnowledgeValues value={event} />
                </details>
              );
            })
        )}
        <details className={styles.details}>
          <summary>대기 중인 이력 참조</summary>
          <KnowledgeValues value={data.pendingHistory} />
        </details>
      </section>
    </div>
  );
}
