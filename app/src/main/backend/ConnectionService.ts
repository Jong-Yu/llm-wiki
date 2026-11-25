import { isServerUnreachable } from './serverReachability';
import type { AccountPreferencesStore } from './AccountPreferencesStore';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type {
  ProtectedConnectionStore,
  SavedConnection,
} from './ProtectedConnectionStore';
import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type {
  DocumentKnowledgeRequest,
  DocumentKnowledgeResult,
} from '@contracts/knowledge.contract';
import type {
  ChooseSourceFileResult,
  SourceReceiptRequest,
  SourceRegistrationRequest,
  SourceRegistrationResult,
  SourceSessionRequest,
  SourceVersionsRequest,
  SourceVersionsResult,
  SourceDownloadRequest,
  SourceDownloadResult,
} from '@contracts/sources.contract';
import { SourceRegistrationService } from './SourceRegistrationService';
import type { RegistrationSession } from './SourceRegistrationService';
import type { ApiFailure } from './readApi';
import type {
  DocumentContentRequest,
  DocumentContentResult,
  DocumentListRequest,
  DocumentListResult,
  SourcePreviewRequest,
  SourcePreviewResult,
} from '@contracts/documents.contract';
import { apiFailure, readApiJson } from './readApi';
import { DocumentReadService } from './DocumentReadService';
import type {
  DocumentReadContext,
  SourceOriginalResult,
} from './DocumentReadService';
export type { SourceOriginalResult } from './DocumentReadService';
import {
  sameAccessRevision,
  parseAccessContext,
  parseConnectionResult,
} from '@contracts/connection.contract';
import type {
  AccountRequest,
  RememberedAccount,
  AccessContext,
  ConnectRequest,
  ConnectionResult,
  ConnectionSnapshot,
  SelectWorkspaceRequest,
  WorkspaceMembership,
  WorkspaceProfile,
  ConnectionProtection,
} from '@contracts/connection.contract';

type Connected = Extract<ConnectionSnapshot, { status: 'connected' }>;
type PendingRequest = { controller: AbortController; generation: number };
/** 토큰을 포함하므로 main 안에서만 사용합니다. renderer 응답에는 넣지 않습니다. */
export type AnalysisContext = {
  active: Connected;
  token: string;
  generation: number;
  selection: { tenant: string; profile: string };
};

/** 새 요청에 대체된 이전 작업의 결과를 상태에 반영하지 않도록 알립니다. */
const superseded = (): ReturnType<typeof apiFailure> =>
  apiFailure(
    'superseded',
    '새 요청이나 연결 해제로 이전 요청이 취소되었습니다.',
  );

/** 주소 검사는 실제 요청 전 수행하며 사용자 지정 reverse proxy prefix를 유지합니다. */
function apiUrl(input: string): string {
  const url = new URL(input);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_url');
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '')}/`;
  if (!url.pathname.endsWith('/api/v1/')) url.pathname += 'api/v1/';
  return url.href;
}

/** PoC는 서버가 허용한 기본값 중 조회 제한이 없는 설정만 사용합니다. */
function workspaceDefault(
  workspace: WorkspaceMembership | undefined,
): WorkspaceProfile | null {
  return (
    workspace?.profiles.find(
      (profile: WorkspaceProfile): boolean =>
        profile.id === workspace.defaultProfile &&
        profile.domain === null &&
        profile.viewpoint === null,
    ) ?? null
  );
}

/** 서버 설정을 앱에서 우회하거나 다른 허용값으로 임의 대체하지 않습니다. */
function workspaceDefaultFailure(): ApiFailure {
  return apiFailure(
    'workspace_default_invalid',
    '작업 공간의 기본 조회 설정을 사용할 수 없습니다. 관리자에게 기본 조회 범위를 전체로 설정해 달라고 요청해 주세요.',
  );
}

/** 자격 증명은 main 메모리·선택한 보호 저장소에만 두고 공개 상태와 분리합니다. */
export class ConnectionService {
  readonly #protection: ProtectedConnectionStore | undefined;
  #initialization: Promise<ConnectionResult> | null = null;
  #rememberRequested = false;
  #remembered = false;
  #protectionGeneration = 0;
  #restoreIssue: ConnectionProtection['issue'] = 'none';
  #account: RememberedAccount | undefined;
  #warning: string | undefined;
  #autoRestore = true;
  #active: Connected | null = null;
  #token: string | null = null;
  #generation = 0;
  #pending: AbortController | null = null;
  #scopeListeners = new Set<() => void>();

  readonly preferences: AccountPreferencesStore | undefined;
  constructor(
    protection?: ProtectedConnectionStore,
    preferences?: AccountPreferencesStore,
  ) {
    this.preferences = preferences;
    this.#protection = protection;
  }

  /** 앱 시작 때 한 번만 복원하며 실패 후에는 사용자의 재시도 의도를 기다립니다. */
  initialize(): Promise<ConnectionResult> {
    this.#initialization ??= this.restoreSaved();
    return this.#initialization;
  }

  /** 저장한 사용자가 선택한 범위를 현재 서버 권한과 대조한 뒤에만 활성화합니다. */
  async restoreSaved(): Promise<ConnectionResult> {
    if (!this.#protection) return this.getState();
    const { controller, generation } = this.#begin();
    const protectionGeneration = ++this.#protectionGeneration;
    const current = (): boolean =>
      generation === this.#generation &&
      protectionGeneration === this.#protectionGeneration;
    this.#restoreIssue = 'none';
    try {
      try {
        const account = await this.preferences?.load();
        if (!current()) return superseded();
        if (account) {
          this.#account = { name: account.name, serverUrl: account.serverUrl };
          this.#autoRestore = account.autoRestore;
        }
      } catch {
        this.#autoRestore = false;
        this.#warning =
          '계정 기억 파일을 읽지 못해 자동 로그인을 차단했습니다.';
      }
      const stored = await this.#protection.load();
      if (!current()) return superseded();
      if (!this.#autoRestore) return this.getState();
      if (!stored.ok)
        return apiFailure(
          'protection_unavailable',
          '저장한 연결을 열 수 없습니다. 보호 저장 진단을 확인하고 새로 연결해 주세요. 기존 저장 파일은 보존했습니다.',
        );
      if (!stored.entry) return this.getState();
      const entry = stored.entry;
      let serverUrl: string;
      try {
        serverUrl = apiUrl(entry.serverUrl);
      } catch {
        this.#restoreIssue = 'storage_corrupt';
        return apiFailure(
          'protection_corrupt',
          '저장한 연결 주소를 확인할 수 없습니다. 기존 파일은 보존했습니다.',
        );
      }
      const result = await this.#read(serverUrl, entry.token, controller);
      if (!current()) return superseded();
      const restoresActiveCredential =
        this.#active?.serverUrl === serverUrl && this.#token === entry.token;
      if ('ok' in result) {
        if (
          restoresActiveCredential &&
          (result.error.status === 401 || result.error.status === 403)
        )
          this.disconnect();
        this.#restoreIssue = 'restore_failed';
        return result;
      }
      if (result.userId !== entry.userId) {
        if (restoresActiveCredential) this.disconnect();
        this.#restoreIssue = 'identity_changed';
        return apiFailure(
          'subject_changed',
          '저장한 연결의 인증 사용자가 변경되었습니다. 개인 토큰을 다시 입력해 주세요.',
        );
      }
      const scope = entry.selection;
      const workspace = result.workspaces.find(
        (item: WorkspaceMembership): boolean => item.id === scope?.tenant,
      );
      const profile = workspace?.profiles.find(
        (item: WorkspaceProfile): boolean => item.id === scope?.profile,
      );
      if (
        ((!entry.awaitingWorkspaceAssignment || scope !== null) &&
          !sameAccessRevision(result, entry)) ||
        (scope &&
          (!workspace?.permissions.includes('read') ||
            !profile ||
            profile.domain !== scope.domain ||
            profile.viewpoint !== scope.viewpoint))
      ) {
        if (restoresActiveCredential) this.#clearSelection();
        this.#restoreIssue = 'scope_changed';
        return apiFailure(
          'access_changed',
          '저장 이후 권한 또는 조회 설정이 변경되었습니다. 새로 연결하고 현재 작업 공간을 선택해 주세요.',
        );
      }
      if (scope) {
        const neutral = workspaceDefault(workspace);
        if (!neutral || scope.profile !== neutral.id) {
          if (restoresActiveCredential) this.#clearSelection();
          this.#restoreIssue = 'scope_changed';
          return !neutral
            ? workspaceDefaultFailure()
            : apiFailure(
                'workspace_selection_changed',
                '이전에 저장한 작업 공간 설정은 현재 앱에서 사용할 수 없습니다. 다시 로그인하거나 작업 공간을 다시 선택해 주세요. 기존 저장 내용은 보존했습니다.',
              );
        }
      }
      let selection = scope
        ? { tenant: scope.tenant, profile: scope.profile }
        : null;
      if (entry.awaitingWorkspaceAssignment && result.workspaces.length > 0) {
        const assigned = result.workspaces.find(
          (item: WorkspaceMembership): boolean =>
            item.id === result.defaultTenant,
        );
        const neutral = workspaceDefault(assigned);
        if (!assigned?.permissions.includes('read') || !neutral)
          return workspaceDefaultFailure();
        selection = { tenant: assigned.id, profile: neutral.id };
      }
      this.#active = {
        status: 'connected',
        connectionId: randomUUID(),
        serverUrl,
        ...result,
        selection,
        checkedAt: new Date().toISOString(),
      };
      this.#token = entry.token;
      if (result.displayName)
        this.#account = { name: result.displayName, serverUrl };
      this.#rememberRequested = true;
      this.#remembered = true;
      if (entry.awaitingWorkspaceAssignment || result.workspaces.length === 0)
        await this.#persist(generation);
      return current() ? this.getState() : superseded();
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }

  /** 저장 의도가 있는 현재 연결만 보호 저장하며 실패는 연결 성공과 구분합니다. */
  async #persist(generation: number): Promise<void> {
    const store = this.#protection;
    const active = this.#active;
    const token = this.#token;
    if (!store || !active || !token) return;
    const protectionGeneration = this.#protectionGeneration;
    const current = (): boolean =>
      generation === this.#generation &&
      protectionGeneration === this.#protectionGeneration;
    if (!current()) return;
    this.#remembered = false;
    if (!this.#rememberRequested) {
      if (store.status().saved) await store.forget(current);
      return;
    }
    const selection = active.selection;
    const profile = active.workspaces
      .find(
        (item: WorkspaceMembership): boolean => item.id === selection?.tenant,
      )
      ?.profiles.find(
        (item: WorkspaceProfile): boolean => item.id === selection?.profile,
      );
    const entry: SavedConnection = {
      version: 1,
      serverUrl: active.serverUrl,
      token,
      userId: active.userId,
      policyRevision: active.policyRevision,
      ...(active.accessRevision
        ? { accessRevision: active.accessRevision }
        : {}),
      ...(active.displayName ? { displayName: active.displayName } : {}),
      ...(active.workspaces.length === 0 && selection === null
        ? { awaitingWorkspaceAssignment: true as const }
        : {}),
      selection:
        selection && profile
          ? {
              ...selection,
              domain: profile.domain,
              viewpoint: profile.viewpoint,
            }
          : null,
    };
    const saved = await store.save(entry, current);
    if (current()) {
      this.#remembered = saved;
      // 인증 파일 확정 뒤에만 복원을 허용해 이전 계정이 되살아나지 않게 합니다.
      if (saved && this.#account && this.preferences) {
        const enabled = await this.preferences.save(
          { version: 1, ...this.#account, autoRestore: true },
          current,
        );
        if (current()) {
          this.#autoRestore = enabled;
          this.#remembered = enabled;
          if (!enabled)
            this.#warning =
              '로그인은 완료됐지만 재시작 로그인 설정을 저장하지 못했습니다.';
        }
      }
    }
  }

  /** 저장된 인증정보만 명시 삭제하며 현재 세션과 서버 자료는 유지합니다. */
  async forgetSaved(): Promise<ConnectionResult> {
    const protectionGeneration = ++this.#protectionGeneration;
    this.#rememberRequested = false;
    this.#remembered = false;
    this.#restoreIssue = 'none';
    if (
      this.#protection &&
      !(await this.#protection.forget(
        (): boolean => protectionGeneration === this.#protectionGeneration,
      ))
    )
      return apiFailure(
        'protection_delete_failed',
        '저장된 연결을 삭제하지 못했습니다. 저장 파일은 보존되어 다음 실행에서 복원될 수 있습니다. 보호 저장 진단을 확인해 주세요.',
      );
    return this.getState();
  }

  /** 네트워크 없이 메모리를 비우고 복원 차단을 먼저 기록합니다. */
  async logout(): Promise<ConnectionResult> {
    this.disconnect();
    this.#autoRestore = false;
    const generation = this.#generation;
    const current = (): boolean => generation === this.#generation;
    const blocked =
      this.#account && this.preferences
        ? await this.preferences.save(
            { version: 1, ...this.#account, autoRestore: false },
            current,
          )
        : false;
    if (!current()) return superseded();
    const deleted =
      !this.#protection || (await this.#protection.forget(current));
    if (!current()) return superseded();
    this.#warning =
      !blocked && !deleted
        ? '로그아웃했지만 저장소 오류로 다음 실행의 자동 로그인 차단을 확인하지 못했습니다. 저장소를 확인하고 로그아웃을 다시 실행해 주세요.'
        : !deleted
          ? '로그아웃과 자동 로그인 차단을 완료했습니다. 보호된 인증 파일 정리는 실패했습니다.'
          : undefined;
    return this.getState();
  }

  /** 로그아웃 정리는 이미 확인한 로컬 신원만 사용하며 서버 조회를 요구하지 않습니다. */
  localContext(): AnalysisContext | null {
    const active = this.#active;
    if (!active?.selection || !this.#token) return null;
    return {
      active,
      token: this.#token,
      generation: this.#generation,
      selection: { ...active.selection },
    };
  }

  /** 정리 실패를 로그아웃 성공과 분리해 비밀 없는 경고로 표시합니다. */
  setLogoutWarning(message: string): ConnectionResult {
    this.#warning = this.#warning ? `${this.#warning} ${message}` : message;
    return this.getState();
  }

  /** 연결 선택이 바뀌면 로컬 AI 실행도 이전 범위에서 계속 쓰지 못하게 합니다. */
  onScopeChanged(listener: () => void): void {
    this.#scopeListeners.add(listener);
  }

  /** 현재 작업이 시작할 때의 연결·관점인지 비교합니다. 비밀 값은 공개하지 않습니다. */
  isAnalysisCurrent(context: AnalysisContext): boolean {
    return (
      context.generation === this.#generation &&
      this.#pending === null &&
      this.#active?.connectionId === context.active.connectionId &&
      this.#active.userId === context.active.userId &&
      sameAccessRevision(this.#active, context.active) &&
      this.#active.selection?.tenant === context.selection.tenant &&
      this.#active.selection.profile === context.selection.profile
    );
  }

  /** 실행/조회 직전에 서버의 현재 소속을 재확인하고 main 전용 인증 문맥을 만듭니다. */
  async analysisContext(
    connectionId: string,
    write: boolean = false,
  ): Promise<AnalysisContext | ReturnType<typeof apiFailure>> {
    const active = this.#active;
    const token = this.#token;
    if (
      !active ||
      !token ||
      active.connectionId !== connectionId ||
      !active.selection ||
      this.#pending
    )
      return apiFailure(
        'connection_changed',
        '작업 공간을 다시 선택해 주세요.',
      );
    const context: AnalysisContext = {
      active,
      token,
      generation: this.#generation,
      selection: { ...active.selection },
    };
    const result = await this.#read(
      active.serverUrl,
      token,
      new AbortController(),
    );
    if (!this.isAnalysisCurrent(context)) return superseded();
    if ('ok' in result) {
      if (!result.ok) this.analysisAccessFailure(result);
      return result;
    }
    if (
      result.userId !== active.userId ||
      !sameAccessRevision(result, active)
    ) {
      this.#clearSelection();
      return apiFailure(
        'access_changed',
        '사용자 또는 권한이 변경되었습니다. 작업 공간을 다시 확인해 주세요.',
      );
    }
    const workspace = result.workspaces.find(
      (item: WorkspaceMembership): boolean =>
        item.id === context.selection.tenant,
    );
    const profile = workspace?.profiles.find(
      (item: WorkspaceProfile): boolean =>
        item.id === context.selection.profile,
    );
    const before = active.workspaces
      .find(
        (item: WorkspaceMembership): boolean =>
          item.id === context.selection.tenant,
      )
      ?.profiles.find(
        (item: WorkspaceProfile): boolean =>
          item.id === context.selection.profile,
      );
    if (
      !workspace?.permissions.includes('read') ||
      !profile ||
      profile.domain !== before?.domain ||
      profile.viewpoint !== before?.viewpoint
    ) {
      this.#clearSelection();
      return apiFailure(
        'access_changed',
        '현재 작업 공간의 조회 권한을 확인할 수 없습니다.',
      );
    }
    const neutral = workspaceDefault(workspace);
    if (!neutral || context.selection.profile !== neutral.id) {
      this.#clearSelection();
      return !neutral
        ? workspaceDefaultFailure()
        : apiFailure(
            'workspace_selection_changed',
            '작업 공간의 기본 설정이 변경되었습니다. 작업 공간을 다시 선택해 주세요.',
          );
    }
    if (write && !workspace.permissions.includes('source_write'))
      return apiFailure(
        'forbidden',
        '분석 요청 권한이 없습니다. 저장 결과는 조회할 수 있습니다.',
      );
    return context;
  }

  /** 이전 문맥의 실행 중단을 알립니다. 저장된 결과에는 손대지 않습니다. */
  #invalidateAnalysis(): void {
    for (const listener of this.#scopeListeners) listener();
  }
  #documents = new DocumentReadService({
    context: (connectionId: string): DocumentReadContext | ApiFailure =>
      this.#documentContext(connectionId),
    isCurrent: (context: DocumentReadContext): boolean =>
      this.#isDocumentCurrent(context),
    disconnect: (): void => {
      this.disconnect();
    },
    clearSelection: (): void => this.#clearSelection(),
    contentFailure: (failure: ApiFailure): void => this.#sourceFailure(failure),
  });
  #sources = new SourceRegistrationService(
    (): RegistrationSession | null => this.#sourceSession(),
    (failure: ApiFailure): void => this.#sourceFailure(failure),
  );

  /** 자격 증명을 제외하고 공개 계약으로 다시 검사한 현재 상태를 반환합니다. */
  getState(): ConnectionResult {
    const protection = this.#protection?.status();
    return parseConnectionResult({
      ok: true,
      data: {
        ...(this.#active ?? { status: 'disconnected' }),
        ...(this.#account ? { rememberedAccount: this.#account } : {}),
        ...(this.#warning ? { warning: this.#warning } : {}),
        ...(this.#active && isServerUnreachable()
          ? { serverUnreachable: true }
          : {}),
        ...(protection
          ? {
              protection: {
                ...protection,
                remembered: this.#remembered,
                issue:
                  protection.issue === 'none'
                    ? this.#restoreIssue
                    : protection.issue,
              },
            }
          : {}),
      },
    });
  }

  /** 진행 중 요청을 무효화하고 메모리의 토큰과 공간 선택을 지웁니다. */
  disconnect(): ConnectionResult {
    this.#invalidateAnalysis();
    this.#generation += 1;
    this.#sources.cancel();
    this.#documents.cancel();
    this.#pending?.abort();
    this.#pending = null;
    this.#active = null;
    this.#token = null;
    this.#rememberRequested = false;
    this.#remembered = false;
    this.#protectionGeneration += 1;
    return this.getState();
  }

  /** 이전 요청을 취소하고 이번 요청만 상태를 갱신할 수 있는 세대를 발급합니다. */
  #begin(): PendingRequest {
    this.#invalidateAnalysis();
    this.#sources.cancel();
    this.#documents.cancel();
    this.#pending?.abort();
    const controller = new AbortController();
    this.#pending = controller;
    const generation = ++this.#generation;
    return { controller, generation };
  }

  /** 지정한 서버의 인증·소속을 실제 조회하고 제한된 오류로 변환합니다. */
  async #read(
    serverUrl: string,
    token: string,
    controller: AbortController,
  ): Promise<AccessContext | ReturnType<typeof apiFailure>> {
    const result = await readApiJson(
      `${serverUrl}access-context`,
      token,
      controller,
    );
    if (!result.ok) return result;
    try {
      return parseAccessContext(result.value);
    } catch {
      return apiFailure(
        'invalid_response',
        '서버의 작업 공간 응답 형식을 확인할 수 없습니다.',
      );
    }
  }

  /** 가입·이름 로그인 응답의 토큰을 main에서만 사용하고 기본 공간을 자동 선택합니다. */
  async authenticate(request: AccountRequest): Promise<ConnectionResult> {
    const initialization = this.initialize();
    const initialGeneration = this.#generation;
    await initialization;
    if (initialGeneration !== this.#generation) return superseded();
    this.disconnect();
    const { controller, generation } = this.#begin();
    const current = (): boolean => generation === this.#generation;
    let serverUrl: string;
    try {
      serverUrl = apiUrl(request.serverUrl);
    } catch {
      this.#pending = null;
      return apiFailure('invalid_url', 'HTTPS 서버 주소를 확인해 주세요.');
    }
    this.#account = { name: request.name, serverUrl };
    this.#warning = undefined;
    this.#autoRestore = false;
    if (
      this.preferences &&
      !(await this.preferences.save(
        { version: 1, ...this.#account, autoRestore: false },
        current,
      ))
    ) {
      this.#warning =
        '이름과 서버 주소를 저장하지 못했습니다. 로그인 상태는 이번 실행에서만 유지될 수 있습니다.';
    }
    if (!current()) return superseded();
    const response = await readApiJson(
      `${serverUrl}auth/${request.mode}`,
      null,
      controller,
      { method: 'POST', body: { name: request.name } },
    );
    if (!current()) return superseded();
    this.#pending = null;
    if (!response.ok) {
      if (!response.error.status || response.error.status >= 500)
        return apiFailure(
          'auth_outcome_unknown',
          request.mode === 'signup'
            ? '가입 결과를 확인하지 못했습니다. 같은 이름으로 로그인해 가입 여부를 확인하세요. 자동으로 다시 가입하지 않습니다.'
            : '로그인 결과를 확인하지 못했습니다. 서버 상태를 확인하고 다시 로그인하세요.',
        );
      return apiFailure(
        response.error.code,
        request.mode === 'signup' && response.error.status === 409
          ? '이미 가입한 이름입니다. 로그인으로 전환해 주세요.'
          : '이름과 서버 상태를 확인해 주세요. 로그인 실패를 자동 가입으로 바꾸지 않습니다.',
        response.error.status,
      );
    }
    try {
      const parsed = z
        .object({
          data: z.object({
            token: z
              .string()
              .min(32)
              .max(4096)
              .regex(/^[a-zA-Z0-9_-]+$/),
            access_revision: z.string().min(1),
            display_name: z.string().min(1),
            default_tenant: z.string().min(1).nullable(),
          }),
        })
        .parse(response.value);
      const access = parseAccessContext(response.value);
      const workspace = access.workspaces.find(
        (item: WorkspaceMembership): boolean =>
          item.id === access.defaultTenant,
      );
      if (workspace && !workspace.permissions.includes('read'))
        throw new Error('invalid_response');
      if (workspace && !workspaceDefault(workspace))
        return workspaceDefaultFailure();
      this.#active = {
        status: 'connected',
        connectionId: randomUUID(),
        serverUrl,
        ...access,
        selection: workspace
          ? { tenant: workspace.id, profile: workspace.defaultProfile }
          : null,
        checkedAt: new Date().toISOString(),
      };
      this.#token = parsed.data.token;
      this.#account = { name: parsed.data.display_name, serverUrl };
      this.#rememberRequested = true;
      this.#restoreIssue = 'none';
      this.#protectionGeneration += 1;
      await this.#persist(generation);
      return current() ? this.getState() : superseded();
    } catch {
      if (!current()) return superseded();
      return apiFailure(
        'auth_outcome_unknown',
        '로그인 응답을 확인하지 못했습니다. 같은 이름으로 로그인해 현재 계정을 확인하세요.',
      );
    }
  }

  /** 새 연결이 검증된 경우에만 기존 공개 상태와 토큰을 교체합니다. */
  async connect(request: ConnectRequest): Promise<ConnectionResult> {
    const initialization = this.initialize();
    const initialGeneration = this.#generation;
    await initialization;
    if (initialGeneration !== this.#generation) return superseded();
    const { controller, generation } = this.#begin();
    let serverUrl: string;
    try {
      serverUrl = apiUrl(request.serverUrl);
    } catch {
      this.#pending = null;
      return apiFailure(
        'invalid_url',
        'HTTPS 서버 주소를 입력해 주세요. HTTP는 이 컴퓨터의 로컬 서버에만 허용됩니다.',
      );
    }
    const result = await this.#read(serverUrl, request.token, controller);
    if (generation !== this.#generation) return superseded();
    this.#pending = null;
    if ('ok' in result) return result;
    this.#active = {
      status: 'connected',
      connectionId: randomUUID(),
      serverUrl,
      ...result,
      selection: null,
      checkedAt: new Date().toISOString(),
    };
    this.#token = request.token;
    this.#restoreIssue = 'none';
    this.#rememberRequested = request.remember === true;
    this.#protectionGeneration += 1;
    await this.#persist(generation);
    if (generation !== this.#generation) return superseded();
    return this.getState();
  }

  /** 현재 토큰으로 소속을 다시 읽고 대기 계정의 서버 기본 배정만 활성화합니다. */
  async refreshAccess(): Promise<ConnectionResult> {
    const active = this.#active;
    const token = this.#token;
    if (!active || !token) return this.getState();
    const { controller, generation } = this.#begin();
    const current = (): boolean =>
      generation === this.#generation &&
      this.#active?.connectionId === active.connectionId;
    try {
      const result = await this.#read(active.serverUrl, token, controller);
      if (!current()) return superseded();
      if ('ok' in result) {
        if (result.error.status === 401 || result.error.status === 403)
          this.disconnect();
        return result;
      }
      if (result.userId !== active.userId) {
        this.disconnect();
        return apiFailure(
          'subject_changed',
          '인증 사용자가 변경되었습니다. 다시 로그인해 주세요.',
        );
      }
      let selection = active.selection;
      if (active.selection) {
        const workspace = result.workspaces.find(
          (item: WorkspaceMembership): boolean =>
            item.id === active.selection?.tenant,
        );
        const neutral = workspaceDefault(workspace);
        if (
          !sameAccessRevision(result, active) ||
          !workspace?.permissions.includes('read') ||
          !neutral ||
          neutral.id !== active.selection.profile
        ) {
          this.#active = {
            ...active,
            ...result,
            selection: null,
            checkedAt: new Date().toISOString(),
          };
          this.#remembered = false;
          return apiFailure(
            'access_changed',
            '권한 또는 기본 조회 설정이 변경되었습니다. 작업 공간을 다시 확인해 주세요.',
          );
        }
      } else if (
        active.workspaces.length === 0 &&
        result.workspaces.length > 0
      ) {
        const workspace = result.workspaces.find(
          (item: WorkspaceMembership): boolean =>
            item.id === result.defaultTenant,
        );
        if (!workspace) return workspaceDefaultFailure();
        if (!workspace.permissions.includes('read'))
          return apiFailure(
            'read_required',
            '배정된 기본 작업 공간의 읽기 권한을 관리자에게 확인해 주세요.',
          );
        const neutral = workspaceDefault(workspace);
        if (!neutral) return workspaceDefaultFailure();
        selection = { tenant: workspace.id, profile: neutral.id };
      }
      this.#active = {
        ...active,
        ...result,
        selection,
        checkedAt: new Date().toISOString(),
      };
      this.#restoreIssue = 'none';
      await this.#persist(generation);
      return current() ? this.getState() : superseded();
    } finally {
      if (this.#pending === controller) this.#pending = null;
    }
  }

  /** 현재 소속을 재조회해 작업 공간의 제한 없는 기본 설정만 선택합니다. */
  async selectWorkspace(
    request: SelectWorkspaceRequest,
  ): Promise<ConnectionResult> {
    const active = this.#active;
    const token = this.#token;
    if (!active || !token || active.connectionId !== request.connectionId)
      return apiFailure(
        'connection_changed',
        '연결이 변경되었습니다. 서버 연결을 다시 확인해 주세요.',
      );
    const { controller, generation } = this.#begin();
    // 재확인이 실패해도 이전 선택을 현재 승인으로 표시하지 않습니다.
    this.#active = { ...active, selection: null };
    this.#remembered = false;
    const result = await this.#read(active.serverUrl, token, controller);
    if (
      generation !== this.#generation ||
      this.#active?.connectionId !== request.connectionId
    )
      return superseded();
    this.#pending = null;
    if ('ok' in result) {
      if (
        !result.ok &&
        (result.error.status === 401 || result.error.status === 403)
      )
        this.disconnect();
      return result;
    }
    if (result.userId !== active.userId) {
      this.disconnect();
      return apiFailure(
        'subject_changed',
        '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
      );
    }
    this.#active = {
      ...active,
      ...result,
      selection: null,
      checkedAt: new Date().toISOString(),
    };
    const workspace = result.workspaces.find(
      (item: WorkspaceMembership): boolean => item.id === request.tenant,
    );
    if (!workspace)
      return apiFailure(
        'access_changed',
        '작업 공간 권한이 변경되었습니다. 현재 허용 목록에서 다시 선택해 주세요.',
      );
    if (!workspace.permissions.includes('read'))
      return apiFailure(
        'read_required',
        '선택한 작업 공간에 자료 조회 권한이 없습니다.',
      );
    const neutral = workspaceDefault(workspace);
    if (!neutral) return workspaceDefaultFailure();
    if (request.profile !== neutral.id)
      return apiFailure(
        'workspace_selection_changed',
        '작업 공간의 기본 설정만 사용할 수 있습니다. 작업 공간을 다시 선택해 주세요.',
      );
    this.#active = {
      ...this.#active,
      selection: { tenant: request.tenant, profile: neutral.id },
    };
    this.#restoreIssue = 'none';
    await this.#persist(generation);
    if (generation !== this.#generation) return superseded();
    return this.getState();
  }

  /** 조회 시작 때 현재 연결·선택·읽기 권한을 한 번 검사합니다. */
  #documentContext(connectionId: string): DocumentReadContext | ApiFailure {
    const active = this.#active;
    const token = this.#token;
    if (!active || !token || active.connectionId !== connectionId)
      return apiFailure(
        'connection_changed',
        '연결이 변경되었습니다. 서버 연결을 다시 확인해 주세요.',
      );
    const selection = active.selection;
    if (!selection)
      return apiFailure(
        'selection_required',
        '작업 공간을 먼저 선택해 주세요.',
      );
    if (this.#pending)
      return apiFailure(
        'connection_changed',
        '연결 확인이 진행 중입니다. 현재 연결을 다시 확인해 주세요.',
      );
    const workspace = active.workspaces.find(
      (item: WorkspaceMembership): boolean => item.id === selection.tenant,
    );
    const profile = workspaceDefault(workspace);
    if (
      !profile ||
      profile.id !== selection.profile ||
      !workspace?.permissions.includes('read')
    ) {
      this.#clearSelection();
      return apiFailure(
        'access_changed',
        '현재 작업 공간의 조회 권한을 다시 확인해 주세요.',
      );
    }
    return { active, token, selection, profile, generation: this.#generation };
  }

  /** 완료된 읽기가 시작할 때와 같은 연결·사용자·조회 범위인지 확인합니다. */
  #isDocumentCurrent(context: DocumentReadContext): boolean {
    const current = this.#active;
    const { active, selection, generation } = context;
    return (
      generation === this.#generation &&
      current?.connectionId === active.connectionId &&
      current.userId === active.userId &&
      sameAccessRevision(current, active) &&
      current.selection?.tenant === selection.tenant &&
      current.selection.profile === selection.profile
    );
  }

  /** 현재 선택의 문서 목록 조회를 위임합니다. */
  listDocuments(request: DocumentListRequest): Promise<DocumentListResult> {
    return this.#documents.listDocuments(request);
  }

  /** 권한 회수나 범위 변경이 감지되면 모든 대기 조회와 선택을 무효화합니다. */
  #clearSelection(): void {
    this.#invalidateAnalysis();
    if (this.#active) this.#active = { ...this.#active, selection: null };
    this.#remembered = false;
    this.#generation += 1;
    this.#sources.cancel();
    this.#documents.cancel();
  }

  /** 원본 작업도 main의 확정된 선택·토큰·세대만 사용합니다. */
  #sourceSession(): RegistrationSession | null {
    const active = this.#active;
    const token = this.#token;
    if (!active || !token || !active.selection || this.#pending) return null;
    return {
      ...active,
      selection: active.selection,
      token,
      generation: this.#generation,
    };
  }

  /** 원본·분석·본문 조회의 인증·범위 무효화를 기존 연결 수명에 반영합니다. */
  #sourceFailure(failure: ApiFailure): void {
    if (
      failure.error.status === 401 ||
      failure.error.code === 'subject_changed'
    )
      this.disconnect();
    else if (
      failure.error.status === 403 ||
      failure.error.code === 'scope_changed'
    )
      this.#clearSelection();
  }

  /** 분석에서도 공통 인증 오류 처리를 사용해 예전 권한의 실행을 즉시 멈춥니다. */
  analysisAccessFailure(failure: ApiFailure): void {
    this.#sourceFailure(failure);
  }

  /** 사용자에게 네이티브 파일 선택을 제공하고 경로 대신 제한된 참조만 공개합니다. */
  chooseSourceFile(
    request: SourceSessionRequest,
    parent: BrowserWindow,
  ): Promise<ChooseSourceFileResult> {
    return this.#sources.chooseFile(request, parent);
  }

  /** 웹 업로드도 현재 권한과 원본 서비스의 동일한 파일 snapshot 경계를 사용합니다. */
  acceptSourceFile(
    request: SourceSessionRequest,
    filename: string,
    bytes: Uint8Array,
  ): Promise<ChooseSourceFileResult> {
    return this.#sources.acceptFile(request, filename, bytes);
  }

  /** 현재 작업 공간에 원본을 한 번 등록하고 불변 판본 영수증을 반환합니다. */
  registerSource(
    request: SourceRegistrationRequest,
  ): Promise<SourceRegistrationResult> {
    return this.#sources.register(request);
  }

  /** 응답 유실/조정 대기는 같은 요청의 읽기 전용 영수증 조회로 확인합니다. */
  checkSourceRegistration(
    request: SourceReceiptRequest,
  ): Promise<SourceRegistrationResult> {
    return this.#sources.receipt(request);
  }

  /** 현재 선택의 본문·판본 조회를 위임합니다. */
  readDocumentContent(
    request: DocumentContentRequest,
  ): Promise<DocumentContentResult> {
    return this.#documents.readDocumentContent(request);
  }

  /** 현재 선택의 기계층·유효 지식 조회를 위임합니다. */
  readDocumentKnowledge(
    request: DocumentKnowledgeRequest,
  ): Promise<DocumentKnowledgeResult> {
    return this.#documents.readDocumentKnowledge(request);
  }

  /** 일반 API의 인증/범위 거부를 앱의 현재 선택 수명에 반영합니다. */
  invalidateApiScope(code: string, status?: number): void {
    if (status === 401 || code === 'subject_changed') this.disconnect();
    else if (
      status === 403 ||
      ['scope_changed', 'access_changed'].includes(code)
    )
      this.#clearSelection();
  }

  /** 원본 카탈로그는 main이 보관한 현재 연결에서만 읽습니다. */
  async readSourceVersions(
    request: SourceVersionsRequest,
  ): Promise<SourceVersionsResult> {
    return this.#sources.versions(request);
  }

  /** 웹 다운로드에는 현재 권한·카탈로그·해시를 확인한 원본만 내부 전송기로 반환합니다. */
  readSourceDownload(
    request: SourceDownloadRequest,
  ): Promise<SourceOriginalResult> {
    return this.#documents.readSourceOriginal(request);
  }

  /** 원본 해시를 확인한 전체 바이트만 사용자가 고른 새 파일로 저장합니다. */
  async downloadSource(
    request: SourceDownloadRequest,
    parent: BrowserWindow,
  ): Promise<SourceDownloadResult> {
    const generation = this.#generation;
    const active = this.#active;
    if (
      !active ||
      active.connectionId !== request.connectionId ||
      !active.selection
    )
      return superseded();
    const { dialog } = await import('electron');
    const selected = await dialog.showSaveDialog(parent, {
      title: '원본 내려받기',
      defaultPath: `original.${request.format}`,
      filters: [{ name: '원본 파일', extensions: [request.format] }],
    });
    if (generation !== this.#generation) return superseded();
    if (selected.canceled || !selected.filePath)
      return { ok: true, data: { saved: false } };
    // 저장 창을 기다린 뒤 현재 권한·카탈로그와 실제 바이트를 다시 확인해 보관합니다.
    const result = await this.#documents.readSourceOriginal(request);
    if (!result.ok) return result;
    if (generation !== this.#generation) return superseded();
    try {
      await writeFile(selected.filePath, result.data.bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      return { ok: true, data: { saved: true } };
    } catch {
      return apiFailure(
        'file_save_failed',
        '파일을 저장하지 못했습니다. 기존 파일과 다른 이름 또는 위치를 선택해 주세요.',
      );
    }
  }

  /** 원본 읽기와 공개 미리보기 구분을 조회 서비스에 위임합니다. */
  readSourcePreview(
    request: SourcePreviewRequest,
  ): Promise<SourcePreviewResult> {
    return this.#documents.readSourcePreview(request);
  }
}
