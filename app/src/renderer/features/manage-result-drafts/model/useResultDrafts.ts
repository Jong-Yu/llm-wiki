import { createRecoverySlot } from '@renderer/platform/recovery';
import type { RecoverySlot } from '@renderer/platform/recovery';
import { decodeDraftRecovery, draftRecoveryValue } from './draftRecovery';
import { useEffect, useRef, useState } from 'react';
import {
  confirmedApplication,
  confirmedDraftId,
  listDrafts,
  loadDraftSession,
  readDraft,
  readDraftTarget,
  requestDraft,
  sameDraftScope,
} from '../api/resultDrafts.api';
import {
  canApplyDraft,
  emptyDraftState,
  isDraftAccessError,
  newDraftRequestId,
} from './resultDrafts';
import type {
  DraftCommand,
  DraftDetail,
  DraftError,
  DraftForm,
  DraftPage,
  DraftPending,
  DraftSession,
  DraftState,
} from './resultDrafts';

type SessionState =
  | { status: 'loading' }
  | { status: 'ready'; data: DraftSession }
  | { status: 'error'; error: DraftError };
type Model = {
  session: SessionState;
  state: DraftState;
  page: DraftPage | null;
  busy: boolean;
  previousForm: DraftForm | null;
  recoveryNotice: string;
  discardRecovery: () => Promise<void>;
  changeForm: (form: DraftForm) => void;
  setAcknowledged: (checked: boolean) => void;
  setCompared: (checked: boolean) => void;
  refresh: (cursor?: string | null) => Promise<void>;
  select: (id: string) => Promise<void>;
  create: (id: string) => Promise<void>;
  save: (form: DraftForm) => Promise<void>;
  apply: () => Promise<void>;
  confirm: () => Promise<void>;
  inspect: () => Promise<void>;
  beginMerge: () => void;
  target: (document: string) => Promise<void>;
  clearTarget: () => void;
  resetForm: () => void;
};
// 화면 이동 중에도 초안과 미확인 요청을 보존하고 다른 주체의 화면에는 공개하지 않습니다.
const preserved = new Map<string, DraftState>();
/** 개인 자료의 메모리 보관 경계를 고정합니다. */
function keyOf(session: DraftSession): string {
  return JSON.stringify([
    session.connectionId,
    session.userId,
    session.tenant,
    session.profileId,
    session.policyRevision,
  ]);
}
/** 입력이 복구 한도를 넘으면 비동기 실패로 표시하고 편집 화면은 유지합니다. */
async function persistDraftRecovery(
  slot: RecoverySlot<DraftState>,
  state: DraftState,
): Promise<void> {
  await slot.save(draftRecoveryValue(state));
}
/** 초안·대상 CAS와 명시 관측 확인, 응답 유실의 영수증 복구를 조정합니다. */
export function useResultDrafts(): Model {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [state, setState] = useState<DraftState>(emptyDraftState);
  const [page, setPage] = useState<DraftPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const recovery = useRef<RecoverySlot<DraftState> | null>(null);
  const recoveryWrites = useRef(0);
  const alive = useRef(false);
  const lock = useRef(false);
  const active = useRef<DraftSession | null>(null);
  const current = useRef(state);
  /** 상태 저장은 같은 범위에만 연결하며 오래된 비동기 응답을 버립니다. */
  function update(change: (value: DraftState) => DraftState): void {
    if (!alive.current) return;
    const next = change(current.current);
    current.current = next;
    if (active.current) preserved.set(keyOf(active.current), next);
    setState(next);
    if (recovery.current) {
      recoveryWrites.current += 1;
      setRecoveryNotice(
        '로컬 복구 저장 중 · 완료 전 종료하면 마지막 확정 입력만 복원됩니다.',
      );
      void persistDraftRecovery(recovery.current, next).then(
        (): void => {
          recoveryWrites.current -= 1;
          if (alive.current && recoveryWrites.current === 0)
            setRecoveryNotice('종료 후 복구용 보호 저장 완료');
        },
        (reason: unknown): void => {
          recoveryWrites.current -= 1;
          if (alive.current)
            setRecoveryNotice(
              reason instanceof Error
                ? reason.message
                : '로컬 복구 저장 실패. 현재 입력은 메모리에 남아 있습니다.',
            );
        },
      );
    }
  }
  /** 접근 실패에서는 본문을 숨기고 원래 범위의 메모리 초안은 지우지 않습니다. */
  function error(value: DraftError): void {
    update((old: DraftState): DraftState => ({
      ...old,
      error: value,
      message: '',
      conflict: old.conflict || value.code === 'conflict',
    }));
    if (isDraftAccessError(value))
      setSession({ status: 'error', error: value });
  }
  /** 화면의 중복 클릭과 이전 수명 응답을 차단합니다. */
  async function run(
    action: (scope: DraftSession) => Promise<void>,
  ): Promise<void> {
    if (lock.current || !active.current || session.status !== 'ready') return;
    lock.current = true;
    setBusy(true);
    try {
      await action(active.current);
    } catch {
      error({
        code: 'unavailable',
        message: '요청을 완료하지 못했습니다. 초안과 요청 정보를 보존했습니다.',
      });
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect((): (() => void) => {
    alive.current = true;
    let valid = true;
    void loadDraftSession().then(
      async (
        result: Awaited<ReturnType<typeof loadDraftSession>>,
      ): Promise<void> => {
        if (!valid) return;
        if (!result.ok) {
          setSession({ status: 'error', error: result.error });
          return;
        }
        const scope = result.data;
        const slot = createRecoverySlot(
          scope,
          'result-drafts',
          'workspace',
          decodeDraftRecovery,
        );
        let recovered: DraftState | null = null;
        try {
          recovered = await slot.load();
        } catch (reason: unknown) {
          if (valid)
            setRecoveryNotice(
              reason instanceof Error
                ? reason.message
                : '복구 자료를 읽지 못했습니다.',
            );
        }
        if (!valid) return;
        // 서버 목록·상세를 먼저 재조회하고 로컬 입력의 revision은 교체하지 않습니다.
        const listed = await listDrafts(scope, null);
        if (!valid) return;
        if (!listed.ok && isDraftAccessError(listed.error)) {
          setSession({ status: 'error', error: listed.error });
          return;
        }
        const cached =
          preserved.get(keyOf(scope)) || recovered || emptyDraftState();
        const restored: DraftState = {
          ...cached,
          acknowledged: null,
          compared: false,
        };
        if (restored.selected) {
          const latest = await readDraft(scope, restored.selected.record.id);
          if (!valid) return;
          if (!latest.ok && isDraftAccessError(latest.error)) {
            setSession({ status: 'error', error: latest.error });
            return;
          }
          if (latest.ok) {
            if (latest.data.revision !== restored.selected.revision) {
              restored.inspection = latest.data;
              restored.conflict = true;
              restored.message =
                '종료 전 편집 기준이 오래되었습니다. 내 입력과 원래 revision을 보존했습니다. 최신 초안을 비교해 병합하세요.';
            } else restored.selected = latest.data;
          } else {
            restored.conflict = true;
            restored.error = latest.error;
          }
          if (restored.target) {
            const target = await readDraftTarget(
              scope,
              restored.target.document,
            );
            if (!valid) return;
            if (!target.ok && isDraftAccessError(target.error)) {
              setSession({ status: 'error', error: target.error });
              return;
            }
            if (
              !target.ok ||
              target.data.revision !== restored.target.revision
            ) {
              restored.message =
                'Wiki 대상의 기준이 변경되었거나 확인되지 않았습니다. 대상 선택을 해제하고 다시 읽어 비교하세요.';
            }
          }
        }
        active.current = scope;
        recovery.current = slot;
        current.current = restored;
        setState(restored);
        setSession({ status: 'ready', data: scope });
        if (listed.ok) setPage(listed.data);
        else
          setState((old: DraftState): DraftState => ({
            ...old,
            error: listed.error,
          }));
      },
    );
    /** 다시 활성화한 창은 주체를 확인하기 전 기존 자료를 재사용하지 않습니다. */
    const check = (): void => {
      const scope = active.current;
      if (!scope) return;
      void loadDraftSession().then(
        (result: Awaited<ReturnType<typeof loadDraftSession>>): void => {
          if (!valid) return;
          if (!result.ok || !sameDraftScope(scope, result.data))
            setSession({
              status: 'error',
              error: result.ok
                ? {
                    code: 'scope_changed',
                    message:
                      '허용 범위가 변경되었습니다. 원래 초안은 보존했습니다. 화면을 다시 열어 주세요.',
                  }
                : result.error,
            });
        },
      );
    };
    window.addEventListener('focus', check);
    const timer = window.setInterval(check, 10_000);
    return (): void => {
      valid = false;
      alive.current = false;
      active.current = null;
      recovery.current = null;
      window.removeEventListener('focus', check);
      window.clearInterval(timer);
    };
  }, []);
  /** 서버 전체 본문을 편집 기준으로 읽으며 현재 입력을 자동 병합하지 않습니다. */
  async function loaded(scope: DraftSession, id: string): Promise<void> {
    const result = await readDraft(scope, id);
    if (!result.ok) {
      error(result.error);
      return;
    }
    update((old: DraftState): DraftState => ({
      ...emptyDraftState(),
      selected: result.data,
      form: result.data.draft,
      message: old.message,
    }));
  }
  /** 저장 응답 또는 영수증의 실제 증거만 상태에 반영합니다. */
  async function resolve(
    scope: DraftSession,
    command: DraftCommand,
    pending: DraftPending,
  ): Promise<void> {
    const result = await requestDraft(scope, command);
    if (!alive.current) return;
    if (!result.ok) {
      if (
        result.error.code !== 'outcome_unknown' &&
        command.operation !== 'receipt' &&
        command.operation !== 'applicationReceipt'
      )
        update((old: DraftState): DraftState => ({ ...old, pending: null }));
      error(result.error);
      return;
    }
    if (pending.operation === 'apply') {
      const application = confirmedApplication(result.data, pending);
      if (!application) {
        error({
          code: 'outcome_unknown',
          message: '동일 반영 요청의 저장 증거를 확인하지 못했습니다.',
        });
        return;
      }
      update((old: DraftState): DraftState => ({
        ...old,
        applied: application,
        pending: application.saved === null ? pending : null,
        error: null,
        compared: false,
        message:
          application.saved === true
            ? 'Wiki 저장 완료. 같은 반영 요청을 다시 보내지 않습니다.'
            : application.saved === false
              ? '반영이 거절되었습니다. 초안은 보존했습니다.'
              : '반영 결과 미확인. 영수증으로 확인하기 전에는 다시 반영하지 않습니다.',
      }));
      return;
    }
    const id = confirmedDraftId(result.data, scope, pending);
    if (!id) {
      error({
        code: 'outcome_unknown',
        message: '같은 요청의 초안 저장 증거를 확인하지 못했습니다.',
      });
      return;
    }
    update((old: DraftState): DraftState => ({
      ...old,
      pending: null,
      error: null,
      conflict: true,
      message: '개인 초안을 저장했습니다. Wiki에는 아직 반영하지 않았습니다.',
    }));
    await loaded(scope, id);
    const listed = await listDrafts(scope, null);
    if (alive.current && listed.ok) setPage(listed.data);
  }
  /** 요청 ID를 먼저 보존한 뒤 한 번의 변경만 보냅니다. */
  async function mutate(
    scope: DraftSession,
    command: DraftCommand,
    pending: DraftPending,
  ): Promise<void> {
    if (current.current.pending) return;
    update((old: DraftState): DraftState => ({
      ...old,
      pending,
      error: null,
      message: '',
    }));
    if (recovery.current) {
      try {
        await recovery.current.save(draftRecoveryValue(current.current));
      } catch (reason: unknown) {
        update((old: DraftState): DraftState => ({ ...old, pending: null }));
        error({
          code: 'recovery_write_failed',
          message:
            reason instanceof Error
              ? reason.message
              : '복구 저장을 완료하지 못해 요청을 보내지 않았습니다.',
        });
        return;
      }
    }
    await resolve(scope, command, pending);
  }
  return {
    session,
    state,
    page,
    busy,
    previousForm: state.previousForm,
    recoveryNotice,
    discardRecovery: async (): Promise<void> => {
      if (current.current.pending) return;
      try {
        await recovery.current?.remove();
        if (active.current) preserved.delete(keyOf(active.current));
        current.current = emptyDraftState();
        setState(current.current);
        setRecoveryNotice(
          '이 화면의 로컬 복구 사본을 삭제했습니다. 서버 저장본은 보존됩니다.',
        );
      } catch (reason: unknown) {
        setRecoveryNotice(
          reason instanceof Error ? reason.message : '로컬 복구 삭제 실패',
        );
      }
    },
    changeForm: (form: DraftForm): void =>
      update((old: DraftState): DraftState => ({
        ...old,
        form,
        compared: false,
      })),
    setAcknowledged: (checked: boolean): void =>
      update((old: DraftState): DraftState => ({
        ...old,
        acknowledged: checked
          ? old.selected?.basis_observation.observation_revision || null
          : null,
      })),
    setCompared: (checked: boolean): void =>
      update((old: DraftState): DraftState => ({ ...old, compared: checked })),
    refresh: async (cursor: string | null = null): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const result = await listDrafts(scope, cursor);
        if (result.ok && alive.current) setPage(result.data);
        else if (!result.ok) error(result.error);
      }),
    select: async (id: string): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => loaded(scope, id)),
    create: async (id: string): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const requestId = newDraftRequestId();
        await mutate(
          scope,
          {
            operation: 'create',
            input: { saved_result_id: id, request_id: requestId },
          },
          { operation: 'create', requestId },
        );
      }),
    save: async (form: DraftForm): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const selected = current.current.selected;
        if (!selected || current.current.conflict) return;
        const requestId = newDraftRequestId();
        await mutate(
          scope,
          {
            operation: 'edit',
            input: {
              draft_id: selected.record.id,
              expected_revision: selected.revision,
              request_id: requestId,
              ...form,
            },
          },
          {
            operation: 'edit',
            requestId,
            draftId: selected.record.id,
            revision: selected.revision,
          },
        );
      }),
    apply: async (): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const old = current.current;
        const selected = old.selected;
        if (!selected || !old.target || !canApplyDraft(old, scope.permissions))
          return;
        const requestId = newDraftRequestId();
        await mutate(
          scope,
          {
            operation: 'apply',
            input: {
              draft_id: selected.record.id,
              request_id: requestId,
              expected_revision: selected.revision,
              document: old.target.document,
              expected_document_revision: old.target.revision,
              expected_basis_observation:
                selected.basis_observation.observation_revision,
              acknowledge_changed_basis:
                old.acknowledged ===
                selected.basis_observation.observation_revision,
            },
          },
          {
            operation: 'apply',
            requestId,
            draftId: selected.record.id,
            document: old.target.document,
            revision: selected.revision,
          },
        );
      }),
    confirm: async (): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const pending = current.current.pending;
        if (!pending) return;
        const command: DraftCommand =
          pending.operation === 'apply' && pending.draftId
            ? {
                operation: 'applicationReceipt',
                input: {
                  draft_id: pending.draftId,
                  request_id: pending.requestId,
                },
              }
            : {
                operation: 'receipt',
                input: {
                  request_id: pending.requestId,
                  ...(pending.draftId ? { record_id: pending.draftId } : {}),
                },
              };
        await resolve(scope, command, pending);
      }),
    inspect: async (): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const old = current.current;
        if (!old.selected) return;
        const result = await readDraft(scope, old.selected.record.id);
        if (!result.ok) {
          error(result.error);
          return;
        }
        update((value: DraftState): DraftState =>
          result.data.revision === value.selected?.revision && !value.conflict
            ? {
                ...value,
                selected: result.data,
                acknowledged: null,
                compared: false,
                error: null,
              }
            : {
                ...value,
                inspection: result.data,
                conflict: true,
                acknowledged: null,
                compared: false,
              },
        );
      }),
    beginMerge: (): void => {
      const old = current.current;
      if (!old.inspection) return;
      const inspection: DraftDetail = old.inspection;
      update((value: DraftState): DraftState => ({
        ...value,
        previousForm: value.form,
        selected: inspection,
        form: inspection.draft,
        inspection: null,
        conflict: false,
        error: null,
        target: null,
        acknowledged: null,
        compared: false,
        message:
          '최신 초안으로 병합 편집을 시작했습니다. 보존된 내 편집 내용을 대조해 필요한 내용을 직접 반영하세요.',
      }));
    },
    target: async (document: string): Promise<void> =>
      run(async (scope: DraftSession): Promise<void> => {
        const result = await readDraftTarget(scope, document);
        if (result.ok)
          update((old: DraftState): DraftState => ({
            ...old,
            target: result.data,
            compared: false,
            error: null,
          }));
        else error(result.error);
      }),
    resetForm: (): void =>
      update((old: DraftState): DraftState =>
        old.selected
          ? {
              ...old,
              previousForm: old.form,
              form: old.selected.draft,
              compared: false,
            }
          : old,
      ),
    clearTarget: (): void =>
      update((old: DraftState): DraftState => ({
        ...old,
        target: null,
        compared: false,
      })),
  };
}
export type ResultDraftModel = ReturnType<typeof useResultDrafts>;
