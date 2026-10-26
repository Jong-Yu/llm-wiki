import type { JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { KnowledgeReviewModel } from '../model/useKnowledgeReview';
import type { ReviewSelection } from '../model/review.types';
import { ReviewStoredValue } from './ReviewStoredValue';
import styles from './ReviewDialog.module.scss';

type ReviewHistoryProps = {
  model: KnowledgeReviewModel;
  selection: ReviewSelection;
};
const undoSchema = z.object({
  reason: z.string().trim().min(1, '되돌리는 이유를 입력해 주세요.').max(1000),
});
type UndoValues = z.infer<typeof undoSchema>;

/** 이벤트의 실제 상세·당시 before/after를 읽고 현재 대상의 마지막 이벤트만 되돌립니다. */
export function ReviewHistory({
  model,
  selection,
}: ReviewHistoryProps): JSX.Element {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UndoValues, unknown>({
    resolver: zodResolver(undoSchema),
    defaultValues: { reason: '' },
  });
  const detail = model.detail.status === 'ready' ? model.detail.data : null;
  const event = detail?.event;
  const eventId = event && typeof event.id === 'string' ? event.id : null;
  const policyEvent =
    event?.action === 'policy' || event?.action === 'policy_undo';
  const context = model.context.status === 'ready' ? model.context.data : null;
  const claim = context?.knowledge.claims.find(
    (item: (typeof context.knowledge.claims)[number]): boolean =>
      item.claim_id === selection.claimId,
  );
  const policy = context?.knowledge.policies.find(
    (item: KnowledgeValue): boolean => {
      const scope = item.scope;
      return (
        item.claim_id === selection.claimId &&
        scope !== null &&
        typeof scope === 'object' &&
        !Array.isArray(scope) &&
        scope.domain === context.knowledge.access.domain &&
        scope.viewpoint === context.knowledge.access.viewpoint
      );
    },
  );
  const currentEventId = policyEvent
    ? policy?.event_id
    : claim?.review_event_id;
  const permission = policyEvent ? 'ontology_policy' : 'ontology_review';
  const canUndo =
    !model.blocked &&
    context?.permissions.includes(permission) === true &&
    detail?.pending === false &&
    detail.stateRevision === selection.stateRevision &&
    event?.claim_id === selection.claimId &&
    eventId !== null &&
    currentEventId === eventId;

  /** 현재 조회한 이벤트의 ID와 처음 편집 기준으로만 명시 역이벤트를 기록합니다. */
  function undo(values: UndoValues): void {
    if (canUndo && eventId)
      model.undo(
        policyEvent ? 'policyUndo' : 'reviewUndo',
        eventId,
        values.reason,
      );
  }
  return (
    <section className={styles.history} aria-label="검토 이벤트 조회">
      <div className={styles.sectionHeading}>
        <h3>검토·판단 기록</h3>
        <Button
          variant="secondary"
          onClick={model.refreshEvents}
          disabled={model.events.status === 'loading'}
        >
          이력 다시 읽기
        </Button>
      </div>
      <p className={styles.muted}>
        현재 문서의 실제 이벤트 페이지입니다. 원문 검토와 업무 판단·과거 근거를
        구분합니다.
      </p>
      {model.events.status === 'loading' ? (
        <StatusNotice title="검토 이력을 불러오고 있습니다" />
      ) : model.events.status === 'error' ? (
        <StatusNotice tone="error" title="검토 이력을 읽지 못했습니다">
          {model.events.error.message}
        </StatusNotice>
      ) : (
        <>
          {model.events.page.items.length === 0 ? (
            <p className={styles.empty}>이 페이지에 검토 이벤트가 없습니다.</p>
          ) : (
            <div className={styles.eventList}>
              {model.events.page.items.map(
                (item: KnowledgeValue, index: number): JSX.Element => (
                  <button
                    type="button"
                    key={typeof item.id === 'string' ? item.id : index}
                    onClick={(): void => {
                      if (typeof item.id === 'string')
                        model.selectEvent(item.id);
                    }}
                  >
                    <strong>
                      {typeof item.action === 'string' ? item.action : '이벤트'}
                      {item.claim_id === selection.claimId
                        ? ' · 선택 주장'
                        : ''}
                    </strong>
                    <span>
                      {typeof item.reason === 'string'
                        ? item.reason
                        : typeof item.id === 'string'
                          ? item.id
                          : '상세 보기'}
                    </span>
                  </button>
                ),
              )}
            </div>
          )}
          {(model.events.page.truncated ||
            model.events.page.skippedCount > 0 ||
            model.events.page.requiresRefresh) && (
            <StatusNotice tone="warning" title="일부 이력 조회">
              조회 한도·누락 또는 목록 기준 변경이 있습니다. 이 페이지를 전체
              이력으로 해석하지 마세요.
            </StatusNotice>
          )}
          <div className={styles.pager}>
            <Button
              variant="secondary"
              onClick={model.previousEvents}
              disabled={model.events.previous.length === 0}
            >
              이전 이력
            </Button>
            <span>{model.events.previous.length + 1}페이지</span>
            <Button
              variant="secondary"
              onClick={model.nextEvents}
              disabled={
                model.events.page.nextCursor === null ||
                model.events.page.requiresRefresh
              }
            >
              다음 이력
            </Button>
          </div>
        </>
      )}
      {model.detail.status === 'loading' && (
        <StatusNotice title="선택 이벤트를 읽고 있습니다" />
      )}
      {model.detail.status === 'error' && (
        <StatusNotice tone="error" title="이벤트 상세를 읽지 못했습니다">
          {model.detail.error.message}
        </StatusNotice>
      )}
      {detail && (
        <section className={styles.eventDetail}>
          <h3>이벤트 당시 기록</h3>
          {detail.pending && (
            <p className={styles.warning}>
              현재 근거에 자동 적용하지 않는 과거/대기 이벤트입니다.
            </p>
          )}
          <ReviewStoredValue value={detail.event} />
          <form
            className={styles.form}
            onSubmit={handleSubmit(undo)}
            noValidate
          >
            <TextareaField
              {...register('reason')}
              label="되돌림 이유"
              rows={2}
              required
              error={errors.reason?.message}
              disabled={!canUndo}
            />
            <Button type="submit" variant="secondary" disabled={!canUndo}>
              {policyEvent
                ? '이 업무 판단 되돌림 기록'
                : '이 원문 검토 되돌림 기록'}
            </Button>
          </form>
          {!canUndo && (
            <p className={styles.muted}>
              되돌림은 현재 주장·현재 근거·같은 관점의 마지막 이벤트와 해당
              권한을 확인한 경우에만 가능합니다.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
