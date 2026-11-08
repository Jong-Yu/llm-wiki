import type { ExportFormat } from '@contracts/fileExports.contract';
import { EXPORT_FORMAT_NAMES } from '@renderer/platform/fileExports';
import { useEffect, useRef, useState } from 'react';
import type { RecoverySlot } from '@renderer/platform/recovery';
import type { QuestionDetail } from '@contracts/questionRuns.contract';
import {
  artifactRecoverySlot,
  canDownloadArtifactMarkdown,
  downloadArtifactMarkdown,
  loadArtifactSession,
  readArtifact,
  readArtifactDraft,
  readArtifactGeneration,
  requestArtifactDraft,
} from '../api/documentArtifact.api';
import {
  artifactDraftRecordSchema,
  artifactFormSchema,
  artifactIdSchema,
  isArtifactAccessError,
  sameArtifactScope,
} from './documentArtifact';
import type {
  ArtifactDraft,
  ArtifactError,
  ArtifactForm,
  ArtifactRecovery,
  ArtifactSession,
  SavedArtifact,
} from './documentArtifact';

type ArtifactState = {
  canWrite: boolean;
  status: 'loading' | 'ready' | 'error';
  artifact: SavedArtifact | null;
  generation: QuestionDetail | null;
  edit: ArtifactRecovery | null;
  inspection: ArtifactDraft | null;
  error: ArtifactError | null;
  busy: boolean;
  message: string;
  recoveryNotice: string;
  downloadError: ArtifactError | null;
};
type DocumentArtifactModel = ArtifactState & {
  canWrite: boolean;
  canDownload: boolean;
  downloadFormat: ExportFormat;
  setDownloadFormat: (format: ExportFormat) => void;
  previousForm: ArtifactForm | null;
  refresh: () => void;
  change: (form: ArtifactForm) => void;
  save: () => Promise<void>;
  confirm: () => Promise<void>;
  inspect: () => Promise<void>;
  beginMerge: () => void;
  download: () => Promise<void>;
};
const preserved = new Map<string, ArtifactRecovery>();

/** 같은 결과의 입력만 같은 연결·사용자·관점에 복원합니다. */
function cacheKey(session: ArtifactSession, artifactId: string): string {
  return JSON.stringify([
    session.connectionId,
    session.userId,
    session.tenant,
    session.profileId,
    session.accessRevision ?? session.policyRevision,
    artifactId,
  ]);
}

/** 읽지 않은 결과를 빈 본문과 구별합니다. */
function initialState(): ArtifactState {
  return {
    canWrite: false,
    status: 'loading',
    artifact: null,
    generation: null,
    edit: null,
    inspection: null,
    error: null,
    busy: false,
    message: '',
    recoveryNotice: '',
    downloadError: null,
  };
}

/** 불변 결과, 별도 편집 초안, CAS와 보호 복구 영역의 수명을 관리합니다. */
export function useDocumentArtifact(
  artifactId: string | null,
  questionRunId: string | null,
  draftId: string | null,
): DocumentArtifactModel {
  const [state, setState] = useState<ArtifactState>(initialState);
  const [reload, setReload] = useState(0);
  const [downloadFormat, setDownloadFormat] = useState<ExportFormat>('md');
  const current = useRef(state);
  const session = useRef<ArtifactSession | null>(null);
  const recovery = useRef<RecoverySlot<ArtifactRecovery> | null>(null);
  const epoch = useRef(0);
  const lock = useRef(false);
  const recoveryVersion = useRef(0);

  /** 비동기 작업은 시작한 화면 수명에만 표시하고 메모리 초안은 별도 보관합니다. */
  function update(change: Partial<ArtifactState>): void {
    current.current = { ...current.current, ...change };
    setState(current.current);
  }

  /** 저장 완료 알림은 최신 입력의 보호 저장 응답에서만 표시합니다. */
  function preserve(edit: ArtifactRecovery): void {
    const active = session.current;
    if (!active) return;
    preserved.set(cacheKey(active, edit.artifactId), edit);
    update({ edit });
    const slot = recovery.current;
    if (!slot) return;
    const turn = epoch.current;
    const version = ++recoveryVersion.current;
    update({ recoveryNotice: '편집 내용 보호 저장 중…' });
    void slot.save(edit).then(
      (): void => {
        if (epoch.current === turn && version === recoveryVersion.current)
          update({ recoveryNotice: '이 PC에 편집 내용 보호 저장 완료' });
      },
      (reason: unknown): void => {
        if (epoch.current === turn && version === recoveryVersion.current)
          update({
            recoveryNotice:
              reason instanceof Error
                ? reason.message
                : '보호 저장에 실패했습니다. 현재 입력은 화면에 유지됩니다.',
          });
      },
    );
  }

  /** 접근 실패 시 자료 표시만 중단하고 원래 범위의 입력은 유지합니다. */
  function report(error: ArtifactError): void {
    if (error.code === 'conflict' && current.current.edit)
      preserve({ ...current.current.edit, conflicted: true });
    update({
      error,
      message: '',
      ...(isArtifactAccessError(error) ? { status: 'error' } : {}),
    });
  }

  useEffect((): (() => void) => {
    const turn = ++epoch.current;
    let valid = true;
    session.current = null;
    recovery.current = null;
    lock.current = false;
    current.current = initialState();
    setState(current.current);
    const obsolete = Symbol('obsolete artifact read');
    /** 모든 읽기 응답은 같은 화면 수명을 확인하고, 떠난 화면의 후속 조회도 중단합니다. */
    async function readCurrent<T>(pending: Promise<T>): Promise<T> {
      const result = await pending;
      if (!valid) throw obsolete;
      return result;
    }
    /** 조회·복원은 자동 저장이나 AI 실행을 시작하지 않습니다. */
    async function load(): Promise<void> {
      if (
        [artifactId, questionRunId, draftId].some(
          (value: string | null): boolean =>
            value !== null && !artifactIdSchema.safeParse(value).success,
        )
      ) {
        update({
          status: 'error',
          error: {
            code: 'invalid_id',
            message:
              '결과물 주소가 올바르지 않습니다. AI 채팅에서 다시 열어 주세요.',
          },
        });
        return;
      }
      const connected = await readCurrent(loadArtifactSession());
      if (!connected.ok) {
        update({ status: 'error', error: connected.error });
        return;
      }
      const active = connected.data;
      session.current = active;
      update({ canWrite: active.permissions.includes('result_write') });
      let artifact: SavedArtifact | null = null;
      let generation: QuestionDetail | null = null;
      let notice = '';
      let warning: ArtifactError | null = null;
      if (artifactId) {
        const result = await readCurrent(readArtifact(active, artifactId));
        if (!result.ok) {
          update({ status: 'error', error: result.error });
          return;
        }
        artifact = result.data;
      }
      if (questionRunId) {
        const result = await readCurrent(
          readArtifactGeneration(active, questionRunId),
        );
        if (!result.ok) {
          if (!artifact || isArtifactAccessError(result.error)) {
            update({ status: 'error', error: result.error });
            return;
          }
          warning = result.error;
        } else generation = result.data;
      }
      let edit: ArtifactRecovery | null = null;
      if (artifact) {
        const id = artifact.record.id;
        const slot = artifactRecoverySlot(active, id);
        recovery.current = slot;
        const recovered = await readCurrent(
          slot.load().catch((reason: unknown): null => {
            notice =
              reason instanceof Error
                ? reason.message
                : '보호 저장된 편집 내용을 읽지 못했습니다.';
            return null;
          }),
        );
        const cached = preserved.get(cacheKey(active, id)) ?? recovered;
        edit =
          cached?.artifactId === id
            ? cached
            : {
                artifactId: id,
                form: {
                  title: artifact.record.data.title,
                  content: artifact.record.data.content,
                },
                draft: null,
                pending: null,
                conflicted: false,
                previousForm: null,
              };
        const selectedDraftId = draftId ?? edit.draft?.record.id;
        if (selectedDraftId) {
          const loaded = await readCurrent(
            readArtifactDraft(active, selectedDraftId, artifact),
          );
          if (!loaded.ok) {
            warning = loaded.error;
          } else if (!cached)
            edit = { ...edit, draft: loaded.data, form: loaded.data.draft };
          else if (
            edit.draft?.record.id !== selectedDraftId ||
            edit.draft.revision !== loaded.data.revision
          ) {
            update({ inspection: loaded.data });
            warning = {
              code: 'conflict',
              message:
                '서버 초안이 편집 기준과 다릅니다. 보존한 입력과 최신 초안을 비교해 주세요.',
            };
            edit = { ...edit, conflicted: true };
          }
        }
        preserved.set(cacheKey(active, id), edit);
      }
      const stillConnected = await readCurrent(loadArtifactSession());
      if (
        !stillConnected.ok ||
        !sameArtifactScope(active, stillConnected.data)
      ) {
        update({
          status: 'error',
          error: {
            code: 'scope_changed',
            message: '자료를 읽는 동안 연결 범위가 변경되었습니다.',
          },
        });
        return;
      }
      update({
        status: warning && isArtifactAccessError(warning) ? 'error' : 'ready',
        artifact,
        generation,
        edit,
        error: warning,
        recoveryNotice:
          notice ||
          (edit ? '편집 내용은 이 PC의 보호 복구 영역에 보관됩니다.' : ''),
      });
    }
    void load().catch((reason: unknown): void => {
      if (reason !== obsolete) throw reason;
    });
    /** 창으로 돌아왔을 때 권한·관점이 바뀌었으면 이전 개인 본문을 숨깁니다. */
    function checkScope(): void {
      const active = session.current;
      if (!active) return;
      void loadArtifactSession().then(
        (result: Awaited<ReturnType<typeof loadArtifactSession>>): void => {
          if (!valid) return;
          if (!result.ok || !sameArtifactScope(active, result.data))
            update({
              status: 'error',
              error: {
                code: 'scope_changed',
                message:
                  '현재 연결 범위가 변경되었습니다. 원래 범위의 편집 내용은 보존했습니다.',
              },
            });
        },
      );
    }
    window.addEventListener('focus', checkScope);
    return (): void => {
      valid = false;
      if (epoch.current === turn) epoch.current += 1;
      window.removeEventListener('focus', checkScope);
    };
  }, [artifactId, questionRunId, draftId, reload]);

  /** 중복 쓰기와 다른 화면으로 전달되는 늦은 응답을 차단합니다. */
  async function run(
    action: (active: ArtifactSession, turn: number) => Promise<void>,
  ): Promise<void> {
    if (lock.current || !session.current || current.current.status !== 'ready')
      return;
    const turn = epoch.current;
    lock.current = true;
    update({ busy: true });
    try {
      await action(session.current, turn);
    } catch {
      if (epoch.current === turn)
        report({
          code: 'unavailable',
          message: '요청을 완료하지 못했습니다. 결과와 입력은 유지됩니다.',
        });
    } finally {
      if (epoch.current === turn) {
        lock.current = false;
        update({ busy: false });
      }
    }
  }

  /** 실제 동일 요청 영수증을 확인한 뒤 읽은 초안을 저장 기준으로 사용합니다. */
  async function accept(
    value: unknown,
    active: ArtifactSession,
    pending: NonNullable<ArtifactRecovery['pending']>,
    turn: number,
  ): Promise<boolean> {
    const artifact = current.current.artifact;
    const parsed = artifactDraftRecordSchema.safeParse(value);
    if (
      !artifact ||
      !parsed.success ||
      parsed.data.record.tenant !== active.tenant ||
      parsed.data.record.user_id !== active.userId ||
      parsed.data.record.data.source_result_id !== artifact.record.id ||
      parsed.data.record.data.source_result_revision !== artifact.revision ||
      (pending.draftId !== null && parsed.data.record.id !== pending.draftId) ||
      !parsed.data.record.requests[pending.requestId]
    ) {
      report({
        code: 'outcome_unknown',
        message:
          '같은 요청의 저장 증거를 확인하지 못했습니다. 저장 결과 확인을 이용해 주세요.',
      });
      return false;
    }
    const loaded = await readArtifactDraft(
      active,
      parsed.data.record.id,
      artifact,
    );
    if (epoch.current !== turn) return false;
    if (!loaded.ok) {
      report(loaded.error);
      return false;
    }
    const edit = current.current.edit;
    if (!edit) return false;
    // 확인 사이에 다른 편집이 들어오면 최신 revision으로 자동 재전송하지 않습니다.
    if (loaded.data.revision !== parsed.data.revision) {
      preserve({ ...edit, pending: null });
      update({ inspection: loaded.data });
      report({
        code: 'conflict',
        message:
          '저장 후 초안이 다시 변경되었습니다. 최신 초안과 비교해 주세요.',
      });
      return false;
    }
    preserve({ ...edit, draft: loaded.data, pending: null, conflicted: false });
    update({
      error: null,
      inspection: null,
      message:
        pending.operation === 'create'
          ? '편집 초안을 만들었습니다.'
          : '개인 편집 초안을 저장했습니다.',
    });
    return true;
  }

  /** 생성과 수정은 사용자 저장 의도 안에서만 실행하고 각각 실제 영수증을 확인합니다. */
  async function save(): Promise<void> {
    await run(async (active: ArtifactSession, turn: number): Promise<void> => {
      let edit = current.current.edit;
      if (
        !edit ||
        edit.pending ||
        !active.permissions.includes('result_write') ||
        edit.conflicted
      )
        return;
      const parsed = artifactFormSchema.safeParse(edit.form);
      if (!parsed.success) {
        report({
          code: 'validation',
          message: parsed.error.issues[0]?.message ?? '입력을 확인해 주세요.',
        });
        return;
      }
      const operations: ('create' | 'edit')[] = edit.draft
        ? ['edit']
        : ['create', 'edit'];
      for (const operation of operations) {
        edit = current.current.edit;
        if (!edit) return;
        const pending = {
          operation,
          requestId: crypto.randomUUID().replaceAll('-', ''),
          draftId: edit.draft?.record.id ?? null,
        };
        preserve({ ...edit, pending });
        const command =
          operation === 'create'
            ? ({
                operation,
                input: {
                  request_id: pending.requestId,
                  saved_result_id: edit.artifactId,
                },
              } as const)
            : edit.draft
              ? ({
                  operation,
                  input: {
                    draft_id: edit.draft.record.id,
                    expected_revision: edit.draft.revision,
                    request_id: pending.requestId,
                    title: parsed.data.title,
                    content: parsed.data.content,
                  },
                } as const)
              : null;
        if (!command) return;
        const result = await requestArtifactDraft(active, command);
        if (epoch.current !== turn) return;
        if (!result.ok) {
          if (
            [
              'conflict',
              'storage_busy',
              'validation_error',
              'invalid_request',
              'forbidden',
            ].includes(result.error.code) ||
            result.error.status === 401 ||
            result.error.status === 403
          )
            preserve({ ...edit, pending: null });
          report(result.error);
          return;
        }
        if (!(await accept(result.data, active, pending, turn))) return;
      }
    });
  }

  /** 응답 유실은 기존 요청 ID로 확인하며 새 쓰기를 만들지 않습니다. */
  async function confirm(): Promise<void> {
    await run(async (active: ArtifactSession, turn: number): Promise<void> => {
      const pending = current.current.edit?.pending;
      if (!pending) return;
      const result = await requestArtifactDraft(active, {
        operation: 'receipt',
        input: {
          request_id: pending.requestId,
          ...(pending.draftId ? { record_id: pending.draftId } : {}),
        },
      });
      if (epoch.current !== turn) return;
      if (!result.ok) {
        report(result.error);
        return;
      }
      await accept(result.data, active, pending, turn);
    });
  }

  /** 충돌한 입력은 바꾸지 않고 최신 서버 본문을 비교용으로 읽습니다. */
  async function inspect(): Promise<void> {
    await run(async (active: ArtifactSession, turn: number): Promise<void> => {
      const edit = current.current.edit;
      const artifact = current.current.artifact;
      if (!edit?.draft || !artifact) return;
      const result = await readArtifactDraft(
        active,
        edit.draft.record.id,
        artifact,
      );
      if (epoch.current !== turn) return;
      if (!result.ok) {
        report(result.error);
        return;
      }
      update({ inspection: result.data });
    });
  }

  /** 최신 본문부터 명시적으로 병합을 시작하며 이전 입력을 비교 영역에 남깁니다. */
  function beginMerge(): void {
    const { edit, inspection } = current.current;
    if (!edit || !inspection || edit.pending) return;
    update({
      inspection: null,
      error: null,
      message:
        '최신 초안에서 병합 편집을 시작했습니다. 이전 입력을 참고해 수정한 뒤 저장해 주세요.',
    });
    preserve({
      ...edit,
      draft: inspection,
      form: inspection.draft,
      previousForm: edit.form,
      conflicted: false,
    });
  }

  /** 현재 편집본만 내보내며 화면이 바뀌면 파일 전달 전에 중단합니다. */
  async function download(): Promise<void> {
    const edit = current.current.edit;
    if (!edit || !current.current.artifact) return;
    await run(async (active: ArtifactSession, turn: number): Promise<void> => {
      update({ downloadError: null, message: '' });
      const result = await downloadArtifactMarkdown(
        active,
        edit.form,
        (): boolean => epoch.current === turn && current.current.edit === edit,
        downloadFormat,
      );
      if (epoch.current === turn)
        update(
          result.ok
            ? {
                message: result.data.started
                  ? (result.data.warning ??
                    `현재 편집 내용의 ${EXPORT_FORMAT_NAMES[downloadFormat]} 내려받기를 시작했습니다. 서버에 저장하거나 승인하지 않았습니다.`)
                  : '파일 저장을 취소했습니다.',
              }
            : { downloadError: result.error },
        );
    });
  }

  return {
    ...state,
    canDownload: canDownloadArtifactMarkdown(),
    downloadFormat,
    setDownloadFormat,
    previousForm: state.edit?.previousForm ?? null,
    refresh: (): void => setReload((value: number): number => value + 1),
    change: (form: ArtifactForm): void => {
      if (current.current.edit && !lock.current)
        preserve({ ...current.current.edit, form });
    },
    save,
    confirm,
    inspect,
    beginMerge,
    download,
  };
}
