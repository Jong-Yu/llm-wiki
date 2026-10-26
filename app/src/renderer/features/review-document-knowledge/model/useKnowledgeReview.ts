import { useEffect, useRef, useState } from 'react';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import {
  loadReviewContext,
  loadReviewEvents,
  loadReviewEvent,
  saveReviewOperation,
} from '../api/reviewKnowledge.api';
import type {
  ReviewContext,
  ReviewError,
  ReviewEventPage,
  ReviewEventDetail,
  ReviewMutation,
  ReviewOutcome,
  ReviewScope,
  ReviewSelection,
} from './review.types';

type ContextState =
  | { status: 'loading' }
  | { status: 'ready'; data: ReviewContext }
  | { status: 'error'; error: ReviewError };
type EventsState =
  | { status: 'loading' }
  | {
      status: 'ready';
      page: ReviewEventPage;
      cursor: string | null;
      previous: readonly (string | null)[];
    }
  | { status: 'error'; error: ReviewError };
type DetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: ReviewEventDetail }
  | { status: 'error'; error: ReviewError };
type MutationState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'complete'; data: ReviewMutation }
  | { status: 'error'; error: ReviewError; blocked: boolean };
type KnowledgeReviewInput = {
  connectionId: string;
  selection: ReviewSelection;
  scope: ReviewScope;
  onChanged: (cleanupWarningCount: number) => void;
  onScopeInvalidated: () => void;
};
export type KnowledgeReviewModel = {
  context: ContextState;
  events: EventsState;
  detail: DetailState;
  mutation: MutationState;
  blocked: boolean;
  reload: () => void;
  refreshEvents: () => void;
  nextEvents: () => void;
  previousEvents: () => void;
  selectEvent: (id: string) => void;
  save: (
    mode: 'review' | 'policy',
    action: 'accept' | 'edit' | 'reject' | 'defer',
    reason: string,
    replacement: KnowledgeValue | null,
  ) => void;
  undo: (
    operation: 'reviewUndo' | 'policyUndo',
    eventId: string,
    reason: string,
  ) => void;
};

/** 편집 시작의 복합 판본을 고정하고 충돌 뒤 옛 초안을 새 판본에 자동 저장하지 않습니다. */
export function useKnowledgeReview({
  connectionId,
  selection,
  scope,
  onChanged,
  onScopeInvalidated,
}: KnowledgeReviewInput): KnowledgeReviewModel {
  const [context, setContext] = useState<ContextState>({ status: 'loading' });
  const [events, setEvents] = useState<EventsState>({ status: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ status: 'idle' });
  const [mutation, setMutation] = useState<MutationState>({ status: 'idle' });
  const mounted = useRef(false);
  const generation = useRef(0);
  const eventGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const saving = useRef(false);
  const callbacks = useRef({ onChanged, onScopeInvalidated });
  useEffect((): void => {
    callbacks.current = { onChanged, onScopeInvalidated };
  }, [onChanged, onScopeInvalidated]);

  /** 권한/선택 오류는 부모도 다시 확인하도록 하여 이전 원문을 현재 범위에 남기지 않습니다. */
  function applyError(error: ReviewError): void {
    if (
      error.status === 401 ||
      error.status === 403 ||
      ['scope_changed', 'subject_changed', 'connection_changed'].includes(
        error.code,
      )
    )
      callbacks.current.onScopeInvalidated();
  }

  /** 최초 원문과 이력은 읽기만 수행하고 사용자 동작 없이 검토를 기록하지 않습니다. */
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    void Promise.all([
      loadReviewContext(connectionId, selection, scope),
      loadReviewEvents(connectionId, selection.document, scope),
    ]).then(
      ([loaded, history]: [
        ReviewOutcome<ReviewContext>,
        ReviewOutcome<ReviewEventPage>,
      ]): void => {
        if (!mounted.current || request !== generation.current) return;
        if (loaded.ok) setContext({ status: 'ready', data: loaded.data });
        else {
          setContext({ status: 'error', error: loaded.error });
          applyError(loaded.error);
        }
        if (history.ok)
          setEvents({
            status: 'ready',
            page: history.data,
            cursor: null,
            previous: [],
          });
        else setEvents({ status: 'error', error: history.error });
      },
    );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
      eventGeneration.current += 1;
      detailGeneration.current += 1;
    };
  }, [connectionId, selection, scope]);

  /** 현재 판본은 조회만 갱신하며 편집 기준/초안에는 자동 이식하지 않습니다. */
  function reload(): void {
    setContext({ status: 'loading' });
    const request = ++generation.current;
    void loadReviewContext(connectionId, selection, scope).then(
      (result: ReviewOutcome<ReviewContext>): void => {
        if (!mounted.current || request !== generation.current) return;
        if (result.ok) setContext({ status: 'ready', data: result.data });
        else {
          setContext({ status: 'error', error: result.error });
          applyError(result.error);
        }
      },
    );
  }

  /** 이력 페이지는 서버 cursor만 사용하고 실패 시 이전 상세를 숨깁니다. */
  function readEvents(
    cursor: string | null,
    previous: readonly (string | null)[],
  ): void {
    setEvents({ status: 'loading' });
    setDetail({ status: 'idle' });
    detailGeneration.current += 1;
    const request = ++eventGeneration.current;
    void loadReviewEvents(connectionId, selection.document, scope, cursor).then(
      (result: ReviewOutcome<ReviewEventPage>): void => {
        if (!mounted.current || request !== eventGeneration.current) return;
        if (result.ok)
          setEvents({ status: 'ready', page: result.data, cursor, previous });
        else {
          setEvents({ status: 'error', error: result.error });
          applyError(result.error);
        }
      },
    );
  }
  /** 응답 미확정 때도 GET 이력 확인만 실행합니다. */
  function refreshEvents(): void {
    readEvents(null, []);
  }
  /** 같은 기준의 다음 이력을 명시적으로 읽습니다. */
  function nextEvents(): void {
    if (
      events.status === 'ready' &&
      events.page.nextCursor !== null &&
      !events.page.requiresRefresh
    )
      readEvents(events.page.nextCursor, [...events.previous, events.cursor]);
  }
  /** 조회했던 이전 cursor로만 이동합니다. */
  function previousEvents(): void {
    if (events.status !== 'ready' || events.previous.length === 0) return;
    const cursor = events.previous.at(-1);
    if (cursor !== undefined) readEvents(cursor, events.previous.slice(0, -1));
  }
  /** 이벤트 상세는 현재 클릭의 실제 GET 결과만 표시합니다. */
  function selectEvent(id: string): void {
    const request = ++detailGeneration.current;
    setDetail({ status: 'loading' });
    void loadReviewEvent(connectionId, selection.document, id, scope).then(
      (result: ReviewOutcome<ReviewEventDetail>): void => {
        if (!mounted.current || request !== detailGeneration.current) return;
        if (result.ok) setDetail({ status: 'ready', data: result.data });
        else {
          setDetail({ status: 'error', error: result.error });
          applyError(result.error);
        }
      },
    );
  }
  const currentClaim =
    context.status === 'ready'
      ? context.data.knowledge.claims.find(
          (claim: ReviewContext['knowledge']['claims'][number]): boolean =>
            claim.claim_id === selection.claimId,
        )
      : undefined;
  const blocked =
    context.status !== 'ready' ||
    context.data.knowledge.stateRevision !== selection.stateRevision ||
    context.data.bodyRevision !== context.data.knowledge.sourceRevision ||
    context.data.knowledge.status !== 'ready' ||
    ![3, 4, 5, 6].includes(
      typeof context.data.knowledge.machineGraph.schema_version === 'number'
        ? context.data.knowledge.machineGraph.schema_version
        : 0,
    ) ||
    context.data.knowledge.machineGraph.needs_reextraction === true ||
    (events.status === 'ready' &&
      events.page.stateRevision !== selection.stateRevision) ||
    (detail.status === 'ready' &&
      detail.data.stateRevision !== selection.stateRevision) ||
    !currentClaim ||
    currentClaim.ambiguous ||
    selection.ambiguous === true ||
    mutation.status === 'saving' ||
    mutation.status === 'complete' ||
    (mutation.status === 'error' && mutation.blocked);

  /** 성공/충돌/미확정은 구분하고 같은 쓰기를 자동으로 반복하지 않습니다. */
  async function mutate(
    request: WorkspaceRequest & {
      operation: 'review' | 'policy' | 'reviewUndo' | 'policyUndo';
    },
  ): Promise<void> {
    if (saving.current || blocked) return;
    saving.current = true;
    setMutation({ status: 'saving' });
    const result = await saveReviewOperation(request, scope);
    saving.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      setMutation({ status: 'complete', data: result.data });
      callbacks.current.onChanged(result.data.cleanupWarningCount);
    } else {
      setMutation({
        status: 'error',
        error: result.error,
        blocked:
          result.error.code === 'outcome_unknown' ||
          result.error.code === 'conflict' ||
          result.error.status === 409,
      });
      applyError(result.error);
    }
  }
  /** 원문 검토와 전문가 판단은 별도 작업/권한으로 전송합니다. */
  function save(
    mode: 'review' | 'policy',
    action: 'accept' | 'edit' | 'reject' | 'defer',
    reason: string,
    replacement: KnowledgeValue | null,
  ): void {
    if (mode === 'policy') {
      if (replacement)
        void mutate({
          connectionId,
          operation: 'policy',
          input: {
            document: selection.document,
            claim_id: selection.claimId,
            expected_state_revision: selection.stateRevision,
            reason,
            replacement,
          },
        });
    } else
      void mutate({
        connectionId,
        operation: 'review',
        input: {
          document: selection.document,
          claim_id: selection.claimId,
          expected_state_revision: selection.stateRevision,
          reason,
          action,
          replacement: action === 'edit' ? replacement : null,
        },
      });
  }
  /** 되돌림은 조회한 이벤트와 처음 읽은 상태 판본으로 새 역이벤트를 기록합니다. */
  function undo(
    operation: 'reviewUndo' | 'policyUndo',
    eventId: string,
    reason: string,
  ): void {
    void mutate({
      connectionId,
      operation,
      input: {
        document: selection.document,
        event_id: eventId,
        expected_state_revision: selection.stateRevision,
        reason,
      },
    });
  }
  return {
    context,
    events,
    detail,
    mutation,
    blocked,
    reload,
    refreshEvents,
    nextEvents,
    previousEvents,
    selectEvent,
    save,
    undo,
  };
}
