import { randomUUID } from 'node:crypto';
import type {
  ProtectedConnectionStore,
  SavedConnection,
} from './ProtectedConnectionStore';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { parseDocumentKnowledgeResponse } from '@contracts/knowledge.contract';
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
import {
  parseDocumentContentResponse,
  parseDocumentListResponse,
  parseSourceCatalog,
} from '@contracts/documents.contract';
import type {
  DocumentContentRequest,
  DocumentContentResult,
  DocumentListPage,
  DocumentListRequest,
  DocumentListResult,
  SourcePreviewRequest,
  SourcePreviewResult,
} from '@contracts/documents.contract';
import { apiFailure, readApiJson, readApiSourceBytes } from './readApi';
import { isTextSource, sourceText } from './sourceOriginal';
import {
  parseAccessContext,
  parseConnectionResult,
} from '@contracts/connection.contract';
import type {
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
// 바이트와 변환되지 않은 텍스트는 main 내부에서만 보관하고 공개 미리보기와 분리합니다.
type SourceOriginal = SourcePreviewRequest & {
  bytes: Uint8Array;
  text: string | null;
  access: DocumentListPage['access'];
  traceId: string;
};
type SourceOriginalResult = { ok: true; data: SourceOriginal } | ApiFailure;
/** 토큰을 포함하므로 main 안에서만 사용합니다. renderer 응답에는 넣지 않습니다. */
export type AnalysisContext = {
  active: Connected;
  token: string;
  generation: number;
  selection: { tenant: string; profile: string };
};
const MAX_CONTENT_RESPONSE_BYTES = 8 * 1024 * 1024;

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
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  if (!url.pathname.endsWith('/api/v1/')) url.pathname += 'api/v1/';
  return url.href;
}

/** 자격 증명은 main 메모리·선택한 보호 저장소에만 두고 공개 상태와 분리합니다. */
export class ConnectionService {
  readonly #protection: ProtectedConnectionStore | undefined;
  #initialization: Promise<ConnectionResult> | null = null;
  #rememberRequested = false;
  #remembered = false;
  #protectionGeneration = 0;
  #restoreIssue: ConnectionProtection['issue'] = 'none';
  #active: Connected | null = null;
  #token: string | null = null;
  #generation = 0;
  #pending: AbortController | null = null;
  #listPending: AbortController | null = null;
  #listGeneration = 0;
  #contentRequests = new Set<AbortController>();
  #contentGeneration = 0;
  #scopeListeners = new Set<() => void>();

  constructor(protection?: ProtectedConnectionStore) {
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
      const stored = await this.#protection.load();
      if (!current()) return superseded();
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
        result.policyRevision !== entry.policyRevision ||
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
          '저장 이후 권한 또는 관점이 변경되었습니다. 새로 연결하고 현재 작업 공간을 선택해 주세요.',
        );
      }
      this.#active = {
        status: 'connected',
        connectionId: randomUUID(),
        serverUrl,
        ...result,
        selection: scope
          ? { tenant: scope.tenant, profile: scope.profile }
          : null,
        checkedAt: new Date().toISOString(),
      };
      this.#token = entry.token;
      this.#rememberRequested = true;
      this.#remembered = true;
      return this.getState();
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
    if (current()) this.#remembered = saved;
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

  /** 명시 연결 해제는 메모리를 비우고 저장된 자격 증명도 제거합니다. */
  async logout(): Promise<ConnectionResult> {
    this.disconnect();
    return this.forgetSaved();
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
      this.#active.policyRevision === context.active.policyRevision &&
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
        '작업 공간과 관점을 다시 선택해 주세요.',
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
      result.policyRevision !== active.policyRevision
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
        '현재 작업 공간·관점의 조회 권한을 확인할 수 없습니다.',
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
    this.#cancelList();
    this.#cancelContent();
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
    this.#cancelList();
    this.#cancelContent();
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

  /** 새 연결이 검증된 경우에만 기존 공개 상태와 토큰을 교체합니다. */
  async connect(request: ConnectRequest): Promise<ConnectionResult> {
    await this.initialize();
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

  /** 현재 소속을 재조회해 허용된 작업 공간·관점만 선택합니다. */
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
    if (
      !workspace ||
      !workspace.profiles.some(
        (item: WorkspaceProfile): boolean => item.id === request.profile,
      )
    )
      return apiFailure(
        'access_changed',
        '작업 공간 또는 관점 권한이 변경되었습니다. 현재 허용 목록에서 다시 선택해 주세요.',
      );
    if (!workspace.permissions.includes('read'))
      return apiFailure(
        'read_required',
        '선택한 작업 공간에 자료 조회 권한이 없습니다.',
      );
    this.#active = {
      ...this.#active,
      selection: { tenant: request.tenant, profile: request.profile },
    };
    this.#restoreIssue = 'none';
    await this.#persist(generation);
    if (generation !== this.#generation) return superseded();
    return this.getState();
  }

  /** 연결이나 선택이 바뀔 때 이전 목록이 새 범위에 도착하지 않도록 취소합니다. */
  #cancelList(): void {
    this.#listPending?.abort();
    this.#listPending = null;
    this.#listGeneration += 1;
  }

  /** 목록·본문 응답이 현재 선택의 인증 사용자·정책·관점과 일치하는지 확인합니다. */
  #matchesAccess(
    access: DocumentListPage['access'],
    active: Connected,
    profile: WorkspaceProfile,
  ): boolean {
    return (
      access.userId === active.userId &&
      access.tenant === active.selection?.tenant &&
      access.profileId === active.selection?.profile &&
      access.domain === profile.domain &&
      access.viewpoint === profile.viewpoint &&
      access.policyRevision === active.policyRevision
    );
  }

  /** main의 토큰과 확정된 선택으로만 문서 목록을 조회하고 늦은 범위의 응답을 거부합니다. */
  async listDocuments(
    request: DocumentListRequest,
  ): Promise<DocumentListResult> {
    const active = this.#active;
    const token = this.#token;
    if (!active || !token || active.connectionId !== request.connectionId)
      return apiFailure(
        'connection_changed',
        '연결이 변경되었습니다. 서버 연결을 다시 확인해 주세요.',
      );
    const selection = active.selection;
    if (!selection)
      return apiFailure(
        'selection_required',
        '작업 공간과 관점을 먼저 선택해 주세요.',
      );
    if (this.#pending)
      return apiFailure(
        'connection_changed',
        '연결 확인이 진행 중입니다. 현재 연결을 다시 확인해 주세요.',
      );
    const workspace = active.workspaces.find(
      (item: WorkspaceMembership): boolean => item.id === selection.tenant,
    );
    const profile = workspace?.profiles.find(
      (item: WorkspaceProfile): boolean => item.id === selection.profile,
    );
    if (!profile || !workspace?.permissions.includes('read')) {
      this.#clearSelection();
      return apiFailure(
        'access_changed',
        '현재 작업 공간과 관점의 조회 권한을 다시 확인해 주세요.',
      );
    }
    this.#cancelList();
    const controller = new AbortController();
    this.#listPending = controller;
    const generation = this.#generation;
    const listGeneration = this.#listGeneration;
    const url = new URL(
      `${active.serverUrl}tenants/${encodeURIComponent(selection.tenant)}/documents`,
    );
    url.searchParams.set('profile', selection.profile);
    url.searchParams.set('limit', String(request.limit));
    if (request.cursor !== null) url.searchParams.set('cursor', request.cursor);
    const result = await readApiJson(url.href, token, controller);
    const current = this.#active;
    if (
      generation !== this.#generation ||
      listGeneration !== this.#listGeneration ||
      current?.connectionId !== active.connectionId ||
      current.userId !== active.userId ||
      current.policyRevision !== active.policyRevision ||
      current.selection?.tenant !== selection.tenant ||
      current.selection.profile !== selection.profile
    )
      return superseded();
    this.#listPending = null;
    if (!result.ok) {
      if (result.error.status === 401) this.disconnect();
      else if (result.error.status === 403) {
        this.#clearSelection();
      }
      return result;
    }
    let page: DocumentListPage;
    try {
      page = parseDocumentListResponse(result.value, active.connectionId);
    } catch {
      return apiFailure(
        'invalid_response',
        '서버의 문서 목록 응답 형식을 확인할 수 없습니다.',
      );
    }
    if (page.access.userId !== active.userId) {
      this.disconnect();
      return apiFailure(
        'subject_changed',
        '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
      );
    }
    if (
      page.scope.tenant !== selection.tenant ||
      !this.#matchesAccess(page.access, active, profile)
    ) {
      this.#clearSelection();
      return apiFailure(
        'scope_changed',
        '권한 또는 조회 범위가 변경되었습니다. 작업 공간과 관점을 다시 선택해 주세요.',
      );
    }
    return { ok: true, data: page };
  }

  /** 범위 변경 시 독립 자료의 대기 조회를 모두 취소하고 이전 응답을 무효화합니다. */
  #cancelContent(): void {
    for (const controller of this.#contentRequests) controller.abort();
    this.#contentRequests.clear();
    this.#contentGeneration += 1;
  }

  /** 권한 회수나 범위 변경이 감지되면 모든 대기 조회와 선택을 무효화합니다. */
  #clearSelection(): void {
    this.#invalidateAnalysis();
    if (this.#active) this.#active = { ...this.#active, selection: null };
    this.#remembered = false;
    this.#generation += 1;
    this.#sources.cancel();
    this.#cancelList();
    this.#cancelContent();
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

  /** 원본 쓰기/영수증 조회에서 확인한 인증·범위 무효화를 기존 연결 수명에 반영합니다. */
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

  /** 위키와 원본의 조회 수명·현재 권한 검사를 공유하고 본문별 전송만 분리합니다. */
  async #readSelectedContent<
    T extends { connectionId: string; access: DocumentListPage['access'] },
  >(
    connectionId: string,
    load: (
      active: Connected,
      selection: { tenant: string; profile: string },
      token: string,
      controller: AbortController,
      profile: WorkspaceProfile,
    ) => Promise<{ ok: true; data: T } | ReturnType<typeof apiFailure>>,
  ): Promise<{ ok: true; data: T } | ReturnType<typeof apiFailure>> {
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
        '작업 공간과 관점을 먼저 선택해 주세요.',
      );
    if (this.#pending)
      return apiFailure(
        'connection_changed',
        '연결 확인이 진행 중입니다. 현재 연결을 다시 확인해 주세요.',
      );
    const workspace = active.workspaces.find(
      (item: WorkspaceMembership): boolean => item.id === selection.tenant,
    );
    const profile = workspace?.profiles.find(
      (item: WorkspaceProfile): boolean => item.id === selection.profile,
    );
    if (!profile || !workspace?.permissions.includes('read')) {
      this.#clearSelection();
      return apiFailure(
        'access_changed',
        '현재 작업 공간과 관점의 조회 권한을 다시 확인해 주세요.',
      );
    }
    // 여러 문서의 주장과 원문은 함께 읽을 수 있어야 하며 화면별 선택 수명은 renderer가 검사합니다.
    if (this.#contentRequests.size >= 16)
      return apiFailure(
        'read_busy',
        '자료를 읽고 있습니다. 잠시 후 다시 확인해 주세요.',
      );
    const controller = new AbortController();
    this.#contentRequests.add(controller);
    const generation = this.#generation;
    const contentGeneration = this.#contentGeneration;
    let result: Awaited<ReturnType<typeof load>>;
    try {
      result = await load(active, selection, token, controller, profile);
    } finally {
      this.#contentRequests.delete(controller);
    }
    const current = this.#active;
    if (
      generation !== this.#generation ||
      contentGeneration !== this.#contentGeneration ||
      current?.connectionId !== active.connectionId ||
      current.userId !== active.userId ||
      current.policyRevision !== active.policyRevision ||
      current.selection?.tenant !== selection.tenant ||
      current.selection.profile !== selection.profile
    )
      return superseded();
    if (!result.ok) {
      if (
        result.error.status === 401 ||
        result.error.code === 'subject_changed'
      )
        this.disconnect();
      else if (
        result.error.status === 403 ||
        result.error.code === 'scope_changed'
      )
        this.#clearSelection();
      return result;
    }
    const document = result.data;
    if (document.access.userId !== active.userId) {
      this.disconnect();
      return apiFailure(
        'subject_changed',
        '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
      );
    }
    if (!this.#matchesAccess(document.access, active, profile)) {
      this.#clearSelection();
      return apiFailure(
        'scope_changed',
        '권한 또는 조회 범위가 변경되었습니다. 작업 공간과 관점을 다시 선택해 주세요.',
      );
    }
    return { ok: true, data: document };
  }

  /** 선택된 위키의 최신 본문과 실제 revision을 조회합니다. */
  async readDocumentContent(
    request: DocumentContentRequest,
  ): Promise<DocumentContentResult> {
    return this.#readSelectedContent(
      request.connectionId,
      async (
        active: Connected,
        selection: { tenant: string; profile: string },
        token: string,
        controller: AbortController,
      ): Promise<DocumentContentResult> => {
        const url = new URL(
          `${active.serverUrl}tenants/${encodeURIComponent(selection.tenant)}/documents/content`,
        );
        url.searchParams.set('document', request.document);
        url.searchParams.set('profile', selection.profile);
        // 본문 1 MiB가 JSON escape로 커지는 경우에만 응답 한도를 넓힙니다.
        const result = await readApiJson(url.href, token, controller, {
          maxResponseBytes: MAX_CONTENT_RESPONSE_BYTES,
        });
        if (!result.ok) return result;
        try {
          const data = parseDocumentContentResponse(
            result.value,
            active.connectionId,
          );
          if (data.document !== request.document)
            throw new Error('invalid_response');
          return { ok: true, data };
        } catch (error: unknown) {
          if (error instanceof Error && error.message === 'document_too_large')
            return apiFailure(
              'document_too_large',
              '문서가 UTF-8 1 MiB 크기 제한을 초과했습니다.',
            );
          return apiFailure(
            'invalid_response',
            '서버의 문서 본문 응답 형식을 확인할 수 없습니다.',
          );
        }
      },
    );
  }

  /** 허용한 문서의 현재 기계층/유효 지식·판단 이력을 원형 그대로 읽습니다. */
  async readDocumentKnowledge(
    request: DocumentKnowledgeRequest,
  ): Promise<DocumentKnowledgeResult> {
    return this.#readSelectedContent(
      request.connectionId,
      async (
        active: Connected,
        selection: { tenant: string; profile: string },
        token: string,
        controller: AbortController,
      ): Promise<DocumentKnowledgeResult> => {
        const url = new URL(
          `${active.serverUrl}tenants/${encodeURIComponent(selection.tenant)}/documents/knowledge`,
        );
        url.searchParams.set('document', request.document);
        url.searchParams.set('profile', selection.profile);
        const result = await readApiJson(url.href, token, controller, {
          maxResponseBytes: 16 * 1024 * 1024,
        });
        if (!result.ok) return result;
        try {
          const data = parseDocumentKnowledgeResponse(
            result.value,
            active.connectionId,
          );
          if (data.document !== request.document)
            throw new Error('document_mismatch');
          return { ok: true, data };
        } catch {
          return apiFailure(
            'invalid_response',
            '저장된 지식의 응답 형식을 확인할 수 없습니다.',
          );
        }
      },
    );
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
    const selected = await dialog.showSaveDialog(parent, {
      title: '원본 내려받기',
      defaultPath: `original.${request.format}`,
      filters: [{ name: '원본 파일', extensions: [request.format] }],
    });
    if (generation !== this.#generation) return superseded();
    if (selected.canceled || !selected.filePath)
      return { ok: true, data: { saved: false } };
    // 저장 창을 기다린 뒤 현재 권한·카탈로그와 실제 바이트를 다시 확인해 보관합니다.
    const result = await this.#readSourceOriginal(request);
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

  /** 바이너리는 내용·경로 대신 고정 판본과 변환 미준비 상태만 공개합니다. */
  async readSourcePreview(
    request: SourcePreviewRequest,
  ): Promise<SourcePreviewResult> {
    const result = await this.#readSourceOriginal(request);
    if (!result.ok) return result;
    const base = {
      ...request,
      access: result.data.access,
      traceId: result.data.traceId,
    };
    if (isTextSource(request.format)) {
      if (result.data.text === null)
        return apiFailure(
          'source_mismatch',
          '원본 텍스트를 확인할 수 없습니다.',
        );
      return {
        ok: true,
        data: {
          ...base,
          format: request.format,
          previewStatus: 'text',
          content: result.data.text,
        },
      };
    }
    return {
      ok: true,
      data: {
        ...base,
        format: request.format,
        previewStatus: 'conversion_required',
        content: null,
      },
    };
  }

  /** 원본 파일 읽기 전후 카탈로그의 접근 범위와 전체 바이트 무결성을 확인합니다. */
  async #readSourceOriginal(
    request: SourcePreviewRequest,
  ): Promise<SourceOriginalResult> {
    return this.#readSelectedContent(
      request.connectionId,
      async (
        active: Connected,
        selection: { tenant: string; profile: string },
        token: string,
        controller: AbortController,
        profile: WorkspaceProfile,
      ): Promise<SourceOriginalResult> => {
        const catalogUrl = new URL(
          `${active.serverUrl}tenants/${encodeURIComponent(selection.tenant)}/sources/${request.sourceId}`,
        );
        catalogUrl.searchParams.set('profile', selection.profile);
        const before = await readApiJson(catalogUrl.href, token, controller);
        if (!before.ok) return before;
        try {
          const catalog = parseSourceCatalog(before.value, request);
          if (catalog.access.userId !== active.userId)
            return apiFailure(
              'subject_changed',
              '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
            );
          if (!this.#matchesAccess(catalog.access, active, profile))
            return apiFailure(
              'scope_changed',
              '권한 또는 조회 범위가 변경되었습니다. 작업 공간과 관점을 다시 선택해 주세요.',
            );
          const fileUrl = new URL(
            `${active.serverUrl}tenants/${encodeURIComponent(selection.tenant)}/sources/${request.sourceId}/versions/${request.sourceVersion}/file`,
          );
          fileUrl.searchParams.set('profile', selection.profile);
          const file = await readApiSourceBytes(
            fileUrl.href,
            token,
            controller,
            request,
          );
          if (!file.ok) return file;
          if (!(file.value instanceof Uint8Array))
            throw new Error('invalid_response');
          const text = isTextSource(request.format)
            ? sourceText(file.value)
            : null;
          // 파일 응답에는 access가 없으므로 전송 중 회수된 권한도 공개 전에 재확인합니다.
          const after = await readApiJson(catalogUrl.href, token, controller);
          if (!after.ok) return after;
          const checked = parseSourceCatalog(after.value, request);
          return {
            ok: true,
            data: { ...request, bytes: file.value, text, ...checked },
          };
        } catch {
          return apiFailure(
            'source_mismatch',
            '선택한 원본의 판본 정보를 확인할 수 없습니다. 목록을 새로 불러와 주세요.',
          );
        }
      },
    );
  }
}
