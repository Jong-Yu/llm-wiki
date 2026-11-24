import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NotificationInspectionResult,
  NotificationMutationResult,
  NotificationWorkflow,
} from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { notificationsApi } from '../api/notifications.api';
import {
  notificationAccessLost,
  notificationRequestId,
  notificationSession,
} from './notificationView';
import type { NotificationDetail, ReviewPage } from './notificationView';

type Inspection = Extract<NotificationInspectionResult, { ok: true }>['data'];
type Phase = 'loading' | 'page' | 'approval' | 'continue' | null;
type MutationIntent = { kind: string; requestId: string; revision: string };
type WorkflowModel = {
  detail: NotificationDetail | null;
  inspection: Inspection | null;
  readinessError: string | null;
  error: string | null;
  uncertain: boolean;
  phase: Phase;
  invalidate: () => void;
  load: () => Promise<void>;
  inspect: () => Promise<void>;
  decide: (page: number, state: ReviewPage['state']) => Promise<boolean>;
  approve: (
    targetDocument: string | undefined,
    continueHere: boolean,
  ) => Promise<void>;
  continueHere: () => Promise<void>;
};

/** 서버 영수증을 받은 뒤에만 다음 단계로 보내며 재진입은 조회만 합니다. */
export function useNotificationWorkflow(
  scope: SourceConversionScope,
  workflowId: string,
): WorkflowModel {
  const active = useWorkspaceActivity();
  const [detail, setDetail] = useState<NotificationDetail | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const pending = useRef(false);
  const live = useRef(true);
  const accessGeneration = useRef(0);
  const accessBlocked = useRef(false);
  const intent = useRef<MutationIntent | null>(null);

  /** 원본 보기에서 접근이 거부된 경우 같은 화면의 보관 문자도 숨깁니다. */
  const invalidate = useCallback((): void => {
    accessGeneration.current += 1;
    accessBlocked.current = true;
    setDetail(null);
    setInspection(null);
    setError('이 자료에 대한 접근 권한을 다시 확인해 주세요.');
  }, []);

  /** 읽기 실패로 마지막 본문을 성공 상태로 오인하지 않으며 접근 거부 시 제거합니다. */
  const load = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setPhase('loading');
    const access = accessGeneration.current;
    try {
      const result = await notificationsApi.read({
        ...notificationSession(scope),
        workflowId,
      });
      if (!live.current || access !== accessGeneration.current) return;
      if (!result.ok) {
        if (notificationAccessLost(result.error)) invalidate();
        throw new Error(result.error.message);
      }
      setDetail(result.data);
      accessBlocked.current = false;
      setUncertain(false);
      setError(null);
    } catch (cause: unknown) {
      if (live.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '작업 상태를 확인하지 못했습니다.',
        );
    } finally {
      pending.current = false;
      if (live.current) setPhase(null);
    }
  }, [invalidate, scope, workflowId]);

  /** 실행 환경 검사는 승인 저장과 별개이며 실행을 시작하지 않습니다. */
  const inspect = useCallback(async (): Promise<void> => {
    const access = accessGeneration.current;
    try {
      const result = await notificationsApi.inspect({
        ...notificationSession(scope),
        workflowId,
      });
      if (!live.current || access !== accessGeneration.current) return;
      if (!result.ok) {
        setInspection(null);
        if (notificationAccessLost(result.error)) invalidate();
        throw new Error(result.error.message);
      }
      setInspection(result.data);
      setReadinessError(null);
    } catch (cause: unknown) {
      if (live.current) {
        setInspection(null);
        setReadinessError(
          cause instanceof Error
            ? cause.message
            : '이 PC의 실행 준비를 확인하지 못했습니다.',
        );
      }
    }
  }, [invalidate, scope, workflowId]);

  useEffect((): (() => void) => {
    live.current = true;
    queueMicrotask((): void => {
      if (live.current) {
        void load();
        void inspect();
      }
    });
    return (): void => {
      live.current = false;
    };
  }, [inspect, load]);
  useEffect((): (() => void) | undefined => {
    if (!active) return;
    const refresh = (): void => {
      void load();
    };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return (): void => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [active, load]);

  /** 응답 유실 후 같은 판본과 동작은 원래 식별자로 재확인합니다. */
  function request(
    kind: string,
    workflow: NotificationWorkflow,
  ): { requestId: string; expectedRevision: string } {
    if (
      intent.current?.kind !== kind ||
      intent.current.revision !== workflow.revision
    ) {
      intent.current = {
        kind,
        requestId: notificationRequestId(),
        revision: workflow.revision,
      };
    }
    return {
      requestId: intent.current.requestId,
      expectedRevision: intent.current.revision,
    };
  }

  /** 오류는 원래 자료를 보존하되 새 승인과 실행을 최신 조회 전까지 잠급니다. */
  function failed(cause: unknown): void {
    if (!live.current) return;
    setUncertain(true);
    setError(
      cause instanceof Error
        ? cause.message
        : '저장 결과를 확인하지 못했습니다. 다시 확인해 주세요.',
    );
  }

  /** 저장 응답의 서버 판본만 채택하고 로컬 낙관 승인값은 만들지 않습니다. */
  function accept(result: NotificationMutationResult): NotificationWorkflow {
    if (accessBlocked.current)
      throw new Error('이 자료에 대한 접근 권한을 다시 확인해 주세요.');
    if (!result.ok) {
      if (notificationAccessLost(result.error)) invalidate();
      throw new Error(result.error.message);
    }
    const workflow = result.data.workflow;
    if (live.current) {
      setDetail(
        (previous: NotificationDetail | null): NotificationDetail | null =>
          previous ? { ...previous, workflow } : null,
      );
      setError(null);
      setUncertain(false);
    }
    intent.current = null;
    return workflow;
  }

  /** 선택한 쪽의 확인을 서버에 저장한 경우에만 화면의 다음 쪽 이동을 허용합니다. */
  async function decide(
    page: number,
    state: ReviewPage['state'],
  ): Promise<boolean> {
    if (
      !detail ||
      pending.current ||
      uncertain ||
      error ||
      detail.workflow.blocked_reason ||
      detail.workflow.state !== 'review'
    )
      return false;
    pending.current = true;
    setPhase('page');
    try {
      const result = await notificationsApi.decide({
        ...notificationSession(scope),
        workflowId,
        ...request(`page:${page}:${state}`, detail.workflow),
        decisions: [{ page, state }],
      });
      if (!live.current) return false;
      accept(result);
      return true;
    } catch (cause: unknown) {
      failed(cause);
      return false;
    } finally {
      pending.current = false;
      if (live.current) setPhase(null);
    }
  }

  /** 서버가 승인한 공유 요청으로 실행 기기를 확보하고 기존 처리 경로를 호출합니다. */
  async function resume(workflow: NotificationWorkflow): Promise<void> {
    if (
      !live.current ||
      accessBlocked.current ||
      workflow.blocked_reason ||
      !inspection?.ready
    )
      return;
    setPhase('continue');
    const result = await notificationsApi.continue({
      ...notificationSession(scope),
      workflowId,
      ...request('continue', workflow),
    });
    if (!live.current) return;
    if (!result.ok) {
      if (notificationAccessLost(result.error)) invalidate();
      throw new Error(result.error.message);
    }
    intent.current = null;
    setDetail(
      (previous: NotificationDetail | null): NotificationDetail | null =>
        previous ? { ...previous, workflow: result.data.workflow } : null,
    );
    setError(null);
    setUncertain(false);
  }

  /** 최종 승인 성공 영수증 없이는 이어가기 호출을 수행하지 않습니다. */
  async function approve(
    targetDocument: string | undefined,
    continueHere: boolean,
  ): Promise<void> {
    if (
      !detail ||
      pending.current ||
      uncertain ||
      error ||
      detail.workflow.blocked_reason ||
      detail.workflow.state !== 'review' ||
      !detail.workflow.pages.length ||
      detail.workflow.pages.some(
        (page: ReviewPage): boolean => page.state !== 'usable',
      )
    )
      return;
    pending.current = true;
    setPhase('approval');
    try {
      const result = await notificationsApi.approve({
        ...notificationSession(scope),
        workflowId,
        ...request(`approve:${targetDocument ?? ''}`, detail.workflow),
        ...(targetDocument ? { targetDocument } : {}),
      });
      if (!live.current) return;
      const workflow = accept(result);
      if (continueHere) await resume(workflow);
    } catch (cause: unknown) {
      failed(cause);
    } finally {
      pending.current = false;
      if (live.current) setPhase(null);
    }
  }

  /** 승인 후 화면 재진입에서는 명시 클릭만 기존 공유 작업을 이어갑니다. */
  async function continueHere(): Promise<void> {
    const resumable =
      detail &&
      !detail.workflow.blocked_reason &&
      (['approved', 'failed', 'stopped'].includes(detail.workflow.state) ||
        (detail.workflow.state === 'claimed' &&
          detail.workflow.execution?.device_id === inspection?.deviceId));
    if (
      !detail ||
      pending.current ||
      uncertain ||
      error ||
      !resumable ||
      !inspection?.ready
    )
      return;
    pending.current = true;
    try {
      await resume(detail.workflow);
    } catch (cause: unknown) {
      failed(cause);
    } finally {
      pending.current = false;
      if (live.current) setPhase(null);
    }
  }

  return {
    detail,
    inspection,
    readinessError,
    error,
    uncertain,
    phase,
    invalidate,
    load,
    inspect,
    decide,
    approve,
    continueHere,
  };
}
