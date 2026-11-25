import { sameAccessRevision } from '@contracts/connection.contract';
import type {
  ConnectionSnapshot,
  WorkspaceProfile,
} from '@contracts/connection.contract';
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
import { parseDocumentKnowledgeResponse } from '@contracts/knowledge.contract';
import type {
  DocumentKnowledgeRequest,
  DocumentKnowledgeResult,
} from '@contracts/knowledge.contract';
import { apiFailure, readApiJson, readApiSourceBytes } from './readApi';
import type { ApiFailure } from './readApi';
import { isTextSource, sourceText } from './sourceOriginal';

type Connected = Extract<ConnectionSnapshot, { status: 'connected' }>;
/** main의 확정된 조회 문맥입니다. 토큰은 renderer로 보내지 않습니다. */
export type DocumentReadContext = {
  active: Connected;
  token: string;
  generation: number;
  selection: { tenant: string; profile: string };
  profile: WorkspaceProfile;
};
interface DocumentReadAccess {
  context: (connectionId: string) => DocumentReadContext | ApiFailure;
  isCurrent: (context: DocumentReadContext) => boolean;
  disconnect: () => void;
  clearSelection: () => void;
  contentFailure: (failure: ApiFailure) => void;
}
// 바이트와 변환되지 않은 텍스트는 main 내부에서만 보관하고 공개 미리보기와 분리합니다.
type SourceOriginal = SourcePreviewRequest & {
  bytes: Uint8Array;
  text: string | null;
  access: DocumentListPage['access'];
  traceId: string;
};
export type SourceOriginalResult =
  | { ok: true; data: SourceOriginal }
  | ApiFailure;
const MAX_CONTENT_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 새 요청에 대체된 이전 작업의 결과를 상태에 반영하지 않도록 알립니다. */
const superseded = (): ReturnType<typeof apiFailure> =>
  apiFailure(
    'superseded',
    '새 요청이나 연결 해제로 이전 요청이 취소되었습니다.',
  );

/** 확정된 연결에서 읽는 목록·본문·지식·원본의 요청 수명과 응답 검사를 맡습니다. */
export class DocumentReadService {
  readonly #access: DocumentReadAccess;
  #listPending: AbortController | null = null;
  #listGeneration = 0;
  #contentRequests = new Set<AbortController>();
  #contentGeneration = 0;

  constructor(access: DocumentReadAccess) {
    this.#access = access;
  }

  /** 연결·선택이 바뀌면 목록과 공유 본문 요청을 순서대로 취소합니다. */
  cancel(): void {
    this.#cancelList();
    this.#cancelContent();
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
      sameAccessRevision(access, active)
    );
  }

  /** main의 토큰과 확정된 선택으로만 문서 목록을 조회하고 늦은 범위의 응답을 거부합니다. */
  async listDocuments(
    request: DocumentListRequest,
  ): Promise<DocumentListResult> {
    const context = this.#access.context(request.connectionId);
    if ('ok' in context) return context;
    const { active, token, selection, profile } = context;
    this.#cancelList();
    const controller = new AbortController();
    this.#listPending = controller;
    const listGeneration = this.#listGeneration;
    const url = new URL(
      `${active.serverUrl}tenants/${encodeURIComponent(selection.tenant)}/documents`,
    );
    url.searchParams.set('profile', selection.profile);
    url.searchParams.set('limit', String(request.limit));
    if (request.groupSources) url.searchParams.set('group_sources', 'true');
    if (request.cursor !== null) url.searchParams.set('cursor', request.cursor);
    const result = await readApiJson(url.href, token, controller);
    if (
      listGeneration !== this.#listGeneration ||
      !this.#access.isCurrent(context)
    )
      return superseded();
    this.#listPending = null;
    if (!result.ok) {
      if (result.error.status === 401) this.#access.disconnect();
      else if (result.error.status === 403) {
        this.#access.clearSelection();
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
      this.#access.disconnect();
      return apiFailure(
        'subject_changed',
        '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
      );
    }
    if (
      page.scope.tenant !== selection.tenant ||
      !this.#matchesAccess(page.access, active, profile)
    ) {
      this.#access.clearSelection();
      return apiFailure(
        'scope_changed',
        '권한 또는 조회 범위가 변경되었습니다. 작업 공간을 다시 선택해 주세요.',
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
    const context = this.#access.context(connectionId);
    if ('ok' in context) return context;
    const { active, token, selection, profile } = context;
    // 여러 문서의 주장과 원문은 함께 읽을 수 있어야 하며 화면별 선택 수명은 renderer가 검사합니다.
    if (this.#contentRequests.size >= 16)
      return apiFailure(
        'read_busy',
        '자료를 읽고 있습니다. 잠시 후 다시 확인해 주세요.',
      );
    const controller = new AbortController();
    this.#contentRequests.add(controller);
    const contentGeneration = this.#contentGeneration;
    let result: Awaited<ReturnType<typeof load>>;
    try {
      result = await load(active, selection, token, controller, profile);
    } finally {
      this.#contentRequests.delete(controller);
    }
    if (
      contentGeneration !== this.#contentGeneration ||
      !this.#access.isCurrent(context)
    )
      return superseded();
    if (!result.ok) {
      this.#access.contentFailure(result);
      return result;
    }
    const document = result.data;
    if (document.access.userId !== active.userId) {
      this.#access.disconnect();
      return apiFailure(
        'subject_changed',
        '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
      );
    }
    if (!this.#matchesAccess(document.access, active, profile)) {
      this.#access.clearSelection();
      return apiFailure(
        'scope_changed',
        '권한 또는 조회 범위가 변경되었습니다. 작업 공간을 다시 선택해 주세요.',
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
        // JSON escape를 포함한 본문 응답에 별도 전송 한도를 적용합니다.
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
        } catch {
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

  /** 바이너리는 내용·경로 대신 고정 판본과 변환 미준비 상태만 공개합니다. */
  async readSourcePreview(
    request: SourcePreviewRequest,
  ): Promise<SourcePreviewResult> {
    const result = await this.readSourceOriginal(request);
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
  async readSourceOriginal(
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
              '권한 또는 조회 범위가 변경되었습니다. 작업 공간을 다시 선택해 주세요.',
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
