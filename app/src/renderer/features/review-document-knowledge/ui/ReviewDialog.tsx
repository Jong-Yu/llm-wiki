import { useState } from 'react';
import type { JSX } from 'react';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { Tabs } from '@renderer/shared/ui/Tabs';
import type { KnowledgeJson } from '@contracts/knowledge.contract';
import { useKnowledgeReview } from '../model/useKnowledgeReview';
import type { ReviewScope, ReviewSelection } from '../model/review.types';
import { ReviewAssertionForm } from './ReviewAssertionForm';
import { ReviewStoredValue } from './ReviewStoredValue';
import { ReviewHistory } from './ReviewHistory';
import styles from './ReviewDialog.module.scss';

export type ReviewDialogProps = {
  selection: ReviewSelection;
  connectionId: string;
  scope: ReviewScope;
  onChanged: (cleanupWarningCount: number) => void;
  onClose: () => void;
  onScopeInvalidated?: () => void;
};

/** 선택한 주장·원문 판본을 고정해 원문 검토/업무 판단/이력 조회를 나눕니다. */
function ReviewDialogBody({
  selection,
  connectionId,
  scope,
  onChanged,
  onClose,
  onScopeInvalidated,
}: ReviewDialogProps): JSX.Element {
  const model = useKnowledgeReview({
    connectionId,
    selection,
    scope,
    onChanged,
    onScopeInvalidated: (): void => {
      if (onScopeInvalidated) onScopeInvalidated();
      else onChanged(0);
      onClose();
    },
  });
  const [tab, setTab] = useState('review');
  const context = model.context.status === 'ready' ? model.context.data : null;
  const mutation = model.mutation;
  const busy = mutation.status === 'saving';
  const evidence = selection.value.evidence;
  let quote: KnowledgeJson = null;
  if (typeof evidence === 'string') quote = evidence;
  else if (
    evidence !== null &&
    typeof evidence === 'object' &&
    !Array.isArray(evidence) &&
    typeof evidence.quote === 'string'
  )
    quote = evidence.quote;
  const basisChanged =
    (context !== null &&
      (context.knowledge.stateRevision !== selection.stateRevision ||
        context.bodyRevision !== context.knowledge.sourceRevision)) ||
    (model.events.status === 'ready' &&
      model.events.page.stateRevision !== selection.stateRevision) ||
    (model.detail.status === 'ready' &&
      model.detail.data.stateRevision !== selection.stateRevision);
  return (
    <Dialog
      open
      onOpenChange={(open: boolean): void => {
        if (!open && !busy) onClose();
      }}
      title="원문 대조·전문가 판단"
      description={selection.title || selection.document}
      className={styles.dialog}
    >
      {model.context.status === 'loading' ? (
        <StatusNotice title="검토할 원문과 권한을 읽고 있습니다" />
      ) : model.context.status === 'error' ? (
        <StatusNotice tone="error" title="검토 기준을 읽지 못했습니다">
          {model.context.error.message}
          <Button variant="secondary" onClick={model.reload}>
            검토 기준 다시 읽기
          </Button>
        </StatusNotice>
      ) : null}
      {basisChanged && (
        <StatusNotice tone="warning" title="편집 기준이 변경되었습니다">
          초안을 보존했습니다. 현재 지식을 다시 조회한 뒤 대상을 재선택해
          주세요. 바뀐 판본에 이 초안을 자동으로 저장하지 않습니다.
        </StatusNotice>
      )}
      {context &&
        !basisChanged &&
        model.blocked &&
        mutation.status === 'idle' && (
          <StatusNotice
            tone="warning"
            title="현재 근거에서 검토를 기록할 수 없습니다"
          >
            오래된 추출·모호한 주장 또는 지원하지 않는 추출 형식입니다. 최신
            원문에서 지식을 다시 확인한 뒤 대상을 선택해 주세요.
          </StatusNotice>
        )}
      {mutation.status === 'error' && (
        <StatusNotice
          tone={mutation.blocked ? 'warning' : 'error'}
          title={
            mutation.error.code === 'outcome_unknown'
              ? '저장 결과를 확인하지 못했습니다'
              : mutation.error.status === 409 ||
                  mutation.error.code === 'conflict'
                ? '다른 변경과 충돌했습니다'
                : '검토를 저장하지 못했습니다'
          }
        >
          <p>{mutation.error.message}</p>
          {mutation.error.traceId && <p>문의 코드: {mutation.error.traceId}</p>}
          {mutation.blocked && (
            <p>
              초안을 보존했습니다. 저장을 반복하지 말고 아래 실제 이력과 현재
              지식을 확인해 주세요.
            </p>
          )}
          <div className={styles.inlineActions}>
            <Button
              variant="secondary"
              onClick={(): void => {
                setTab('history');
                model.refreshEvents();
              }}
            >
              이력으로 결과 확인
            </Button>
            <Button variant="secondary" onClick={model.reload}>
              현재 기준 다시 읽기
            </Button>
            <Button variant="secondary" onClick={(): void => onChanged(0)}>
              현재 지식에서 다시 선택
            </Button>
          </div>
        </StatusNotice>
      )}
      {busy && (
        <StatusNotice title="검토 결과를 기록하고 있습니다">
          같은 변경을 다시 전송하지 않습니다.
        </StatusNotice>
      )}
      {mutation.status === 'complete' && (
        <StatusNotice tone="success" title="새 이벤트를 기록했습니다">
          <p>이벤트: {mutation.data.eventId}</p>
          {mutation.data.cleanupWarningCount > 0 && (
            <p>저장은 완료됐지만 임시 파일 정리 경고가 있습니다.</p>
          )}
        </StatusNotice>
      )}
      {context && (
        <div className={styles.workspace}>
          <section className={styles.source} aria-label="검토 원문">
            <h3>원문과 현재 주장</h3>
            <p className={styles.document}>{selection.document}</p>
            {quote !== null && (
              <blockquote>
                <ReviewStoredValue value={quote} />
              </blockquote>
            )}
            <details>
              <summary>선택한 원래 주장과 전체 조건</summary>
              <ReviewStoredValue value={selection.value} />
            </details>
            <h4>현재 원문 전체</h4>
            <pre className={styles.body}>{context.body}</pre>
            <details>
              <summary>편집 기준 판본</summary>
              <dl className={styles.revisions}>
                <dt>고정 상태 판본</dt>
                <dd>{selection.stateRevision}</dd>
                <dt>현재 조회 상태 판본</dt>
                <dd>{context.knowledge.stateRevision}</dd>
                <dt>읽은 원문 판본</dt>
                <dd>{context.bodyRevision}</dd>
                <dt>선택 관점</dt>
                <dd>{context.knowledge.access.profileId}</dd>
              </dl>
            </details>
          </section>
          <section className={styles.editor} aria-label="검토와 업무 판단 입력">
            <Tabs
              label="검토 작업 구분"
              value={tab}
              onValueChange={(value: string): void => {
                if (!busy) setTab(value);
              }}
              items={[
                {
                  id: 'review',
                  label: '원문 근거 검토',
                  content: (
                    <ReviewAssertionForm
                      mode="review"
                      selection={selection}
                      context={context}
                      disabled={model.blocked}
                      onSubmit={model.save}
                    />
                  ),
                },
                {
                  id: 'policy',
                  label: '전문가 업무 판단',
                  disabled: selection.collection === 'relation_candidates',
                  content:
                    selection.collection === 'relation_candidates' ? (
                      <p>후보는 먼저 원문 근거 검토로 확인합니다.</p>
                    ) : (
                      <ReviewAssertionForm
                        mode="policy"
                        selection={selection}
                        context={context}
                        disabled={model.blocked}
                        onSubmit={model.save}
                      />
                    ),
                },
                {
                  id: 'history',
                  label: '기록·되돌림',
                  content: (
                    <ReviewHistory model={model} selection={selection} />
                  ),
                },
              ]}
            />
          </section>
        </div>
      )}
    </Dialog>
  );
}

/** 명시적으로 새 대상을 선택했을 때만 폼 수명을 바꾸며 초안의 판본을 조용히 갈아끼우지 않습니다. */
export function ReviewDialog(props: ReviewDialogProps): JSX.Element {
  return (
    <ReviewDialogBody
      key={JSON.stringify([
        props.connectionId,
        props.scope.userId,
        props.scope.tenant,
        props.scope.profileId,
        props.scope.policyRevision,
        props.selection.document,
        props.selection.claimId,
        props.selection.stateRevision,
      ])}
      {...props}
    />
  );
}
