import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotificationInspectionResult } from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { registrationDraftSchema } from '@contracts/registrationDrafts.contract';
import type { RegistrationDraft } from '@contracts/registrationDrafts.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { notificationsApi } from '../api/notifications.api';
import {
  notificationAccessLost,
  notificationSession,
  contentText,
} from './notificationView';
import type { NotificationDetail } from './notificationView';
import type { RegistrationUnit } from './registrationUnits';
import { useRegistrationDraft } from './useRegistrationDraft';
import { RegistrationContentSubmission } from './RegistrationContentSubmission';
import type {
  ContentDraft,
  SubmissionPhase,
  RegistrationSubmissionSnapshot,
} from './RegistrationContentSubmission';

type Inspection = Extract<NotificationInspectionResult, { ok: true }>['data'];
type Phase = 'loading' | SubmissionPhase | null;
type DraftBasis = { revision: string; contents: Record<string, string> };
type EditValues = {
  contents: Record<string, string>;
  blanks: string[];
  target: string;
};
type WorkflowModel = {
  detail: NotificationDetail | null;
  inspection: Inspection | null;
  readinessError: string | null;
  error: string | null;
  uncertain: boolean;
  submitted: boolean;
  resuming: boolean;
  basis: DraftBasis | null;
  draft: ReturnType<typeof useRegistrationDraft>;
  phase: Phase;
  restoreDraft: (restored: RegistrationDraft) => void;
  beginEdit: (selected: RegistrationUnit | undefined) => void;
  scheduleDraft: (values: EditValues) => (() => void) | undefined;
  clearDraft: (reason: 'registered' | 'discarded') => Promise<void>;
  invalidate: () => void;
  load: () => Promise<void>;
  inspect: () => Promise<void>;
  submit: (
    drafts: ContentDraft[],
    targetDocument: string,
    values: EditValues,
    onUnsentFailure?: (message: string) => void,
  ) => Promise<string | null>;
};

/** 조회는 실행하지 않고 현재 내용의 명시 제출만 저장 확인 뒤 기존 등록을 이어갑니다. */
export function useNotificationWorkflow(
  scope: SourceConversionScope,
  workflowId: string,
): WorkflowModel {
  const {
    connectionId,
    userId,
    tenant,
    profileId,
    policyRevision,
    accessRevision,
  } = scope;
  // 창 복귀의 동일 범위 재조회가 고정된 제출의 수명을 바꾸지 않도록 요청 기준을 안정화합니다.
  const requestScope = useMemo(
    (): SourceConversionScope => ({
      connectionId,
      userId,
      tenant,
      profileId,
      policyRevision,
      ...(accessRevision ? { accessRevision } : {}),
    }),
    [connectionId, userId, tenant, profileId, policyRevision, accessRevision],
  );
  const active = useWorkspaceActivity();
  const [detail, setDetail] = useState<NotificationDetail | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [submissionState, setSubmissionState] = useState<
    'editing' | 'restored' | 'submitted'
  >('editing');
  const submitted = submissionState === 'submitted';
  const resuming = submissionState === 'restored';
  const [basis, setBasis] = useState<DraftBasis | null>(null);
  const savedSubmission = useRef<unknown>(null);
  const currentDraft = useRef<RegistrationDraft | null>(null);
  const unsaved = useRef(false);
  const editSequence = useRef(0);
  const autoSaveTimer = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const pending = useRef(false);
  const live = useRef(true);
  const accessGeneration = useRef(0);
  const accessBlocked = useRef(false);
  const submission = useRef<RegistrationContentSubmission | null>(null);
  const draft = useRegistrationDraft(
    detail
      ? {
          ...notificationSession(requestScope),
          workflowId,
          sourceRef: detail.workflow.source_ref,
          conversionRef: detail.workflow.conversion_ref,
        }
      : null,
  );
  const { save: saveDraft, clear: clearSavedDraft } = draft;

  /** 보호 초안의 편집 기준과 고정 제출을 같은 전이로 복원합니다. 폼 값은 UI가 표시합니다. */
  const restoreDraft = useCallback((restored: RegistrationDraft): void => {
    setBasis({
      revision: restored.basisRevision,
      contents: restored.basisContents,
    });
    currentDraft.current = restored;
    savedSubmission.current = restored.submission;
    setSubmissionState(restored.submission === null ? 'editing' : 'restored');
  }, []);

  /** 처음 편집한 보고 판본은 서버 자동 재조회로 교체하지 않습니다. */
  function beginEdit(selected: RegistrationUnit | undefined): void {
    unsaved.current = true;
    editSequence.current += 1;
    if (!detail) return;
    if (basis && (!selected || Object.hasOwn(basis.contents, selected.key)))
      return;
    setBasis({
      revision: basis?.revision ?? detail.workflow.revision,
      contents: {
        ...basis?.contents,
        ...(selected
          ? { [selected.key]: contentText(detail, selected) ?? '' }
          : {}),
      },
    });
  }

  /** 편집 중에만 자동 저장하며 고정 제출·복원 대기 중에는 요청을 덮지 않습니다. */
  const scheduleDraft = useCallback(
    (values: EditValues): (() => void) | undefined => {
      if (!basis || !draft.ready || submissionState !== 'editing') return;
      const value: RegistrationDraft = {
        basisRevision: basis.revision,
        basisContents: basis.contents,
        contents: values.contents,
        blankUnits: values.blanks,
        targetDocument: values.target,
        submission: null,
      };
      currentDraft.current = value;
      const sequence = editSequence.current;
      const timer = window.setTimeout((): void => {
        void saveDraft(value)
          .then((): void => {
            if (editSequence.current === sequence) unsaved.current = false;
          })
          .catch((): void => {});
      }, 250);
      autoSaveTimer.current = timer;
      return (): void => window.clearTimeout(timer);
    },
    [basis, draft.ready, saveDraft, submissionState],
  );

  /** 보호 저장이 확인된 뒤에만 편집 기준을 비웁니다. 등록 뒤에는 고정 제출을 유지합니다. */
  async function clearDraft(reason: 'registered' | 'discarded'): Promise<void> {
    if (autoSaveTimer.current !== null)
      window.clearTimeout(autoSaveTimer.current);
    await clearSavedDraft(reason);
    if (reason === 'discarded') {
      setBasis(null);
      currentDraft.current = null;
      unsaved.current = false;
    }
  }

  useEffect((): (() => void) | undefined => {
    if (!basis && !draft.pending) return;
    const warn = (event: BeforeUnloadEvent): void => {
      if (unsaved.current || draft.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return (): void => window.removeEventListener('beforeunload', warn);
  }, [basis, draft.pending, draft.status]);

  // 화면을 떠나는 순간에도 마지막 입력을 저장하고 이전 보호 초안은 실패 시 유지합니다.
  useEffect(
    (): (() => void) => (): void => {
      if (unsaved.current && currentDraft.current)
        void saveDraft(currentDraft.current).catch((): void => {});
    },
    [saveDraft],
  );

  /** 원본 보기에서 접근이 거부되면 보관 문자와 후속 쓰기를 함께 차단합니다. */
  const invalidate = useCallback((): void => {
    accessGeneration.current += 1;
    accessBlocked.current = true;
    setDetail(null);
    setInspection(null);
    setError('이 자료에 대한 접근 권한을 다시 확인해 주세요.');
  }, []);

  /** 미확정 저장 뒤 재조회해도 초안이나 최초 제출 요청을 새 기준으로 바꾸지 않습니다. */
  const load = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setPhase('loading');
    const access = accessGeneration.current;
    try {
      const result = await notificationsApi.read({
        ...notificationSession(requestScope),
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
      if (live.current && access === accessGeneration.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '작업 상태를 확인하지 못했습니다.',
        );
    } finally {
      pending.current = false;
      if (live.current) setPhase(null);
    }
  }, [invalidate, requestScope, workflowId]);

  /** 준비 검사는 화면 안에서 수행하며 사용자에게 별도 실행권 확보를 요구하지 않습니다. */
  const inspect = useCallback(async (): Promise<void> => {
    const access = accessGeneration.current;
    try {
      const result = await notificationsApi.inspect({
        ...notificationSession(requestScope),
        workflowId,
      });
      if (!live.current || access !== accessGeneration.current) return;
      if (!result.ok) {
        if (notificationAccessLost(result.error)) invalidate();
        throw new Error(result.error.message);
      }
      setInspection(result.data);
      setReadinessError(null);
    } catch (cause: unknown) {
      if (live.current && access === accessGeneration.current) {
        setInspection(null);
        setReadinessError(
          cause instanceof Error
            ? cause.message
            : 'AI 실행 준비를 확인하지 못했습니다.',
        );
      }
    }
  }, [invalidate, requestScope, workflowId]);

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
      accessGeneration.current += 1;
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

  /** 최초 내용·판본을 고정한 조정기를 재사용해 중간 실패 후 성공한 저장을 반복하지 않습니다. */
  async function submit(
    drafts: ContentDraft[],
    targetDocument: string,
    values: EditValues,
    onUnsentFailure?: (message: string) => void,
  ): Promise<string | null> {
    if (
      !detail ||
      pending.current ||
      uncertain ||
      error ||
      accessBlocked.current
    )
      return null;
    pending.current = true;
    const access = accessGeneration.current;
    const basisRevision = basis?.revision ?? detail.workflow.revision;
    const saved = savedSubmission.current;
    /** 동일 제출의 요청 ID와 처리 위치를 서버 쓰기 전에 보호 저장합니다. */
    async function persist(
      snapshot: RegistrationSubmissionSnapshot,
    ): Promise<void> {
      const value = registrationDraftSchema.parse({
        basisRevision,
        basisContents: basis?.contents ?? {},
        contents: values.contents,
        blankUnits: values.blanks,
        targetDocument: snapshot.targetDocument,
        submission: snapshot,
      });
      savedSubmission.current = snapshot;
      currentDraft.current = value;
      if (autoSaveTimer.current !== null)
        window.clearTimeout(autoSaveTimer.current);
      await saveDraft(value);
      unsaved.current = false;
    }
    try {
      if (!submission.current) {
        if (!saved && basisRevision !== detail.workflow.revision)
          throw new Error(
            '편집 중 다른 변경이 저장되었습니다. 입력을 보존했으니 최신 내용과 비교해 주세요.',
          );
        const options = {
          scope: requestScope,
          detail,
          drafts,
          targetDocument,
          api: notificationsApi,
          isCurrent: (): boolean =>
            live.current &&
            !accessBlocked.current &&
            access === accessGeneration.current,
          onAccessLost: invalidate,
          onDetail: setDetail,
          onPhase: setPhase,
          persist,
        };
        submission.current = saved
          ? RegistrationContentSubmission.restore(options, saved)
          : new RegistrationContentSubmission(options);
        setSubmissionState('submitted');
      }
      const jobId = await submission.current.submit();
      if (!live.current || access !== accessGeneration.current) return null;
      setError(null);
      setUncertain(false);
      return jobId;
    } catch (cause: unknown) {
      if (live.current && access === accessGeneration.current) {
        if (submission.current?.canEditBeforeSending() && onUnsentFailure) {
          submission.current = null;
          savedSubmission.current = null;
          setSubmissionState('editing');
          if (currentDraft.current)
            currentDraft.current = {
              ...currentDraft.current,
              submission: null,
            };
          unsaved.current = true;
          setUncertain(false);
          setError(null);
          onUnsentFailure(
            cause instanceof Error
              ? cause.message
              : '등록 준비 내용을 저장하지 못했습니다. 입력을 수정한 뒤 다시 시도해 주세요.',
          );
          return null;
        }
        setUncertain(true);
        setError(
          cause instanceof Error
            ? cause.message
            : '저장 결과를 확인하지 못했습니다. 입력은 보존되어 있습니다.',
        );
      }
      return null;
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
    submitted,
    resuming,
    basis,
    draft,
    phase,
    restoreDraft,
    beginEdit,
    scheduleDraft,
    clearDraft,
    invalidate,
    load,
    inspect,
    submit,
  };
}
