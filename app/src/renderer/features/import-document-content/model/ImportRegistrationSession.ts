import { sameAccessRevision } from '@contracts/connection.contract';
import type {
  SourceFile,
  SourceRegistrationRecord,
  SourceRegistrationRequest,
  SourceRegistrationResult,
} from '@contracts/sources.contract';
import {
  checkImport,
  chooseImportFile,
  confirmImportScope,
  importScopeKey,
  submitImport,
} from '../api/importRegistration.api';
import type { ImportScope } from '../api/importRegistration.api';
import {
  importDocumentSchema,
  initialImportValues,
} from './importDocument.schema';
import type { ImportDocumentValues } from './importDocument.schema';

export type CompletedImport = Extract<
  SourceRegistrationRecord,
  { state: 'complete' }
>;
export type ImportRegistrationSnapshot = {
  draft: ImportDocumentValues;
  file: SourceFile | null;
  busy: boolean;
  requestId: string | null;
  completed: CompletedImport | null;
  error: string | null;
  errorStage: 'file' | 'upload' | 'receipt' | null;
  scopeInvalid: boolean;
  foreignRequest: boolean;
  notice: string;
};

/** 라우트 이동 중에도 같은 범위의 초안과 미확정 요청을 보존합니다. */
export class ImportRegistrationSession {
  readonly scope: ImportScope;
  #snapshot: ImportRegistrationSnapshot;
  #listeners = new Set<() => void>();
  constructor(scope: ImportScope) {
    this.scope = scope;
    this.#snapshot = {
      draft: initialImportValues(scope.canExtract),
      file: null,
      busy: false,
      requestId: null,
      completed: null,
      error: null,
      errorStage: null,
      scopeInvalid: false,
      foreignRequest: false,
      notice: '',
    };
  }
  /** React의 외부 저장소 계약에 안정된 snapshot을 제공합니다. */
  getSnapshot = (): ImportRegistrationSnapshot => this.#snapshot;
  /** 화면이 사라져도 진행 중인 요청은 세션에 남겨 중복 등록을 막습니다. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  };
  /** 한 변경을 구독자에게 원자적으로 전달합니다. */
  #update(patch: Partial<ImportRegistrationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#listeners.forEach((listener: () => void): void => listener());
  }
  /** 입력 변경은 전송 중이거나 미확정인 요청의 본문을 바꾸지 않습니다. */
  updateDraft = (draft: ImportDocumentValues): void => {
    if (
      this.#snapshot.busy ||
      this.#snapshot.requestId ||
      this.#snapshot.completed
    )
      return;
    this.#update({ draft });
  };
  /** 원래 범위로 돌아온 경우에만 차단을 해제하며 미확정 요청은 그대로 유지합니다. */
  revalidateScope = async (): Promise<void> => {
    if (this.#snapshot.busy || !(await confirmImportScope(this.scope))) return;
    this.#update({
      scopeInvalid: false,
      error: this.#snapshot.requestId
        ? '원래 등록 요청의 결과를 확인해 주세요.'
        : null,
    });
  };
  /** 파일을 바꿀 때 사용자 제목과 붙여넣기 초안은 보존합니다. */
  chooseFile = async (): Promise<SourceFile | null> => {
    if (
      this.#snapshot.busy ||
      this.#snapshot.requestId ||
      this.#snapshot.completed ||
      this.#snapshot.scopeInvalid
    )
      return null;
    this.#update({ busy: true, error: null, errorStage: null });
    const result = await chooseImportFile(this.scope);
    if (!result.ok) {
      this.#failure(result.error, 'file', false);
      return null;
    }
    this.#update({
      busy: false,
      ...(result.data ? { file: result.data } : {}),
    });
    return result.data;
  };
  /** 명시 등록은 고정 scope와 한 요청 ID로 한 번만 보냅니다. */
  submit = async (draft: ImportDocumentValues): Promise<void> => {
    if (
      this.#snapshot.busy ||
      this.#snapshot.requestId ||
      this.#snapshot.completed ||
      this.#snapshot.scopeInvalid ||
      !this.scope.canRegister
    )
      return;
    const parsed = importDocumentSchema.safeParse(draft);
    if (!parsed.success) return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const {
      userId,
      tenant,
      profileId,
      accessRevision,
      policyRevision,
      connectionId,
    } = this.scope;
    const base = {
      connectionId,
      requestId,
      expectedScope: {
        userId,
        tenant,
        profileId,
        accessRevision,
        policyRevision,
      },
      title: parsed.data.title,
    };
    const request: SourceRegistrationRequest =
      parsed.data.kind === 'file'
        ? { ...base, kind: 'file', fileId: parsed.data.fileId }
        : { ...base, kind: 'text', format: 'md', content: parsed.data.content };
    this.#update({
      draft: parsed.data,
      requestId,
      busy: true,
      error: null,
      errorStage: null,
      notice: '',
      foreignRequest: false,
    });
    this.#apply(await submitImport(this.scope, request), false);
  };
  /** 미확정 요청을 조회하는 중 오류가 나도 잠금을 해제하지 않습니다. */
  check = async (): Promise<void> => {
    const requestId = this.#snapshot.requestId;
    if (!requestId || this.#snapshot.busy || this.#snapshot.scopeInvalid)
      return;
    this.#update({ busy: true, error: null });
    this.#apply(await checkImport(this.scope, requestId), true);
  };
  /** 서버 영수증의 원래 요청과 접근 범위를 확인한 뒤에만 완료로 표시합니다. */
  #apply(result: SourceRegistrationResult, checking: boolean): void {
    if (!result.ok) {
      this.#failure(result.error, checking ? 'receipt' : 'upload', checking);
      return;
    }
    const record = result.data;
    const { scope } = this;
    if (
      record.connectionId !== scope.connectionId ||
      record.requestId !== this.#snapshot.requestId ||
      record.access.userId !== scope.userId ||
      record.access.tenant !== scope.tenant ||
      record.access.profileId !== scope.profileId ||
      !sameAccessRevision(record.access, scope)
    ) {
      this.#failure(
        {
          code: 'outcome_unknown',
          message:
            '등록 확인 결과이 원래 요청과 일치하지 않습니다. 다시 등록하지 않고 상태 확인을 유지합니다.',
        },
        'receipt',
        true,
      );
      return;
    }
    if (record.state === 'pending_reconcile') {
      this.#update({
        busy: false,
        errorStage: 'receipt',
        error:
          '원본 등록을 조정 중입니다. 같은 요청의 확인 결과를 다시 확인해 주세요.',
      });
      return;
    }
    if (this.#snapshot.foreignRequest) {
      this.#update({
        requestId: null,
        busy: false,
        error: null,
        errorStage: null,
        foreignRequest: false,
        notice: `이전 요청의 “${record.item.title}” 원본 보관을 확인했습니다. 현재 입력은 아직 등록되지 않았습니다. 내용을 확인하고 등록해 주세요.`,
      });
      return;
    }
    this.#update({
      completed: record,
      requestId: null,
      busy: false,
      error: null,
      errorStage: null,
    });
  }
  /** 실패 종류에 따라 미확정 잠금과 범위 차단을 별도로 유지합니다. */
  #failure(
    error: Extract<SourceRegistrationResult, { ok: false }>['error'],
    stage: ImportRegistrationSnapshot['errorStage'],
    checking: boolean,
  ): void {
    const scopeInvalid =
      error.status === 401 ||
      error.status === 403 ||
      [
        'scope_changed_before_write',
        'scope_changed',
        'connection_changed',
        'subject_changed',
        'access_changed',
      ].includes(error.code);
    const unknown =
      checking ||
      [
        'scope_changed',
        'connection_changed',
        'subject_changed',
        'outcome_unknown',
        'registration_unresolved',
        'request_conflict',
      ].includes(error.code);
    const foreignRequest =
      this.#snapshot.foreignRequest ||
      (error.code === 'registration_unresolved' &&
        !!error.requestId &&
        error.requestId !== this.#snapshot.requestId);
    this.#update({
      busy: false,
      error: error.message,
      errorStage: stage,
      scopeInvalid,
      foreignRequest,
      requestId: unknown ? (error.requestId ?? this.#snapshot.requestId) : null,
    });
  }
}

const sessions = new Map<string, ImportRegistrationSession>();
/** 인증 기준이 같은 라우트 재방문만 기존 초안을 이어갑니다. */
export function registrationSession(
  scope: ImportScope,
): ImportRegistrationSession {
  const key = importScopeKey(scope);
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = new ImportRegistrationSession(scope);
  sessions.set(key, created);
  return created;
}

/** 완료 뒤 사용자가 요청할 때만 새 등록 초안을 시작합니다. */
export function newRegistrationSession(
  scope: ImportScope,
): ImportRegistrationSession {
  const created = new ImportRegistrationSession(scope);
  sessions.set(importScopeKey(scope), created);
  return created;
}
