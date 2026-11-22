import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { sameAccessRevision } from '@contracts/connection.contract';
import {
  templateDetailSchema,
  templateFileSchema,
  templateSummarySchema,
} from '@contracts/templates.contract';
import type {
  TemplateSession,
  TemplateChooseFileRequest,
  TemplateReadRequest,
  TemplateSaveRequest,
  TemplateArchiveRequest,
  TemplateOriginalRequest,
  TemplatePrepareResultRequest,
  TemplateDownloadResultRequest,
  TemplateListResult,
  TemplateDetailResult,
  TemplateFileResult,
  TemplatePreparedResultResult,
  TemplateDownloadResult,
  TemplateFile,
  TemplatePreparedResult,
} from '@contracts/templates.contract';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import { apiFailure, matchesExpectedScope } from './readApi';
import type { ApiFailure } from './readApi';
import { workspaceHttpFailure } from './WorkspaceApiService';
import { saveMarkdownExport } from './MarkdownExportService';

const MAX_BYTES = 20 * 1024 * 1024;
const GENERATION_ERRORS: Readonly<Record<string, string>> = {
  template_result_invalid:
    '답변의 양식 작성 결과를 확인하지 못했습니다. 템플릿을 선택하고 다시 작성을 요청해 주세요.',
  template_no_change:
    '답변에 템플릿을 변경할 내용이 없습니다. 작성할 내용을 구체적으로 요청해 주세요.',
  template_result_limit:
    '작성 내용이 파일의 허용 크기를 넘었습니다. 작성 범위를 줄여 주세요.',
};
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  policy_revision: z.string(),
  access_revision: z.string().nullish(),
});
const envelopeSchema = z.object({
  data: z.looseObject({ access: accessSchema }),
});
const metadataSchema = z.object({
  id: z.string(),
  revision: z.string(),
  name: z.string(),
  filename: z.string(),
  size_bytes: z.number(),
  sha256: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  archived: z.boolean(),
  instructions: z.string().optional(),
});
type TemplateConnection = Pick<
  ConnectionService,
  | 'analysisContext'
  | 'isAnalysisCurrent'
  | 'onScopeChanged'
  | 'analysisAccessFailure'
>;
type FileSelection = {
  info: TemplateFile;
  bytes: Uint8Array;
  context: AnalysisContext;
};
type Prepared = {
  info: TemplatePreparedResult;
  bytes: Uint8Array;
  context: AnalysisContext;
  templateId: string;
  revision: string;
};
type BytesResult =
  | { ok: true; bytes: Uint8Array; headers: Headers }
  | ApiFailure;
type JsonResult =
  | { ok: true; value: z.infer<typeof envelopeSchema>['data'] }
  | ApiFailure;

/** 스코프 변경은 실패한 저장을 임의로 다시 보내지 않도록 별도 안내합니다. */
function changed(): ApiFailure {
  return apiFailure(
    'scope_changed',
    '작업 공간 또는 접근 권한이 바뀌었습니다. 현재 공간에서 다시 확인해 주세요.',
  );
}
/** 서버 필드 이름은 이 경계에서만 제품 표시 모델로 바꿉니다. */
function metadata(value: unknown): Record<string, unknown> {
  const item = metadataSchema.parse(value);
  return {
    ...item,
    sizeBytes: item.size_bytes,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}
/** 로컬 파일 경로와 바이트를 main에 두고 인증된 템플릿 API에만 전달합니다. */
export class TemplateService {
  #connection: TemplateConnection;
  #selected = new Map<string, FileSelection>();
  #prepared = new Map<string, Prepared>();
  #requests = new Set<AbortController>();
  #choosing = false;
  #downloading = false;

  constructor(connection: TemplateConnection) {
    this.#connection = connection;
    connection.onScopeChanged((): void => {
      for (const request of this.#requests) request.abort();
      this.#selected.clear();
      this.#prepared.clear();
    });
  }

  /** 매 작업에서 서버의 현재 접근 범위를 다시 확인합니다. */
  async #context(
    request: TemplateSession,
    write: boolean = false,
  ): Promise<AnalysisContext | ApiFailure> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    if (!matchesExpectedScope(request.expectedScope, context)) return changed();
    const workspace = context.active.workspaces.find(
      (item: AnalysisContext['active']['workspaces'][number]): boolean =>
        item.id === context.selection.tenant,
    );
    if (
      !workspace?.permissions.includes('read') ||
      (write && !workspace.permissions.includes('source_write'))
    )
      return apiFailure(
        'forbidden',
        '이 템플릿 작업을 실행할 권한이 없습니다.',
        403,
      );
    return context;
  }

  /** 한정된 주소만 호출하고 실제 수신 크기·응답 수명·실패를 확인합니다. */
  async #request(
    context: AnalysisContext,
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    body?: FormData | Record<string, unknown>,
    mutation: boolean = false,
  ): Promise<BytesResult> {
    const controller = new AbortController();
    this.#requests.add(controller);
    const timeout = setTimeout((): void => controller.abort(), 60_000);
    try {
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      const query =
        method === 'GET'
          ? `?${new URLSearchParams({ profile: context.selection.profile }).toString()}`
          : '';
      const response = await fetch(
        `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/templates${path}${query}`,
        {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${context.token}`,
            ...(body && !(body instanceof FormData)
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          ...(body
            ? { body: body instanceof FormData ? body : JSON.stringify(body) }
            : {}),
        },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('missing_body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > MAX_BYTES) throw new Error('response_limit');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch((): void => {});
        reader.releaseLock();
      }
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (!response.ok) {
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          value = null;
        }
        const failure = workspaceHttpFailure(response.status, value, mutation);
        this.#connection.analysisAccessFailure(failure);
        const generationMessage = GENERATION_ERRORS[failure.error.code];
        if (!mutation && response.status === 422 && generationMessage)
          return {
            ok: false,
            error: { ...failure.error, message: generationMessage },
          };
        return failure;
      }
      return { ok: true, bytes, headers: response.headers };
    } catch {
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      return apiFailure(
        mutation ? 'outcome_unknown' : 'request_failed',
        mutation
          ? '저장 결과를 확인하지 못했습니다. 입력을 유지한 채 같은 요청으로 다시 확인해 주세요.'
          : '템플릿 요청을 완료하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.',
      );
    } finally {
      clearTimeout(timeout);
      this.#requests.delete(controller);
    }
  }

  /** JSON 응답의 사용자·공간·권한 판본까지 검증합니다. */
  async #json(
    context: AnalysisContext,
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    body?: FormData | Record<string, unknown>,
    mutation: boolean = false,
  ): Promise<JsonResult> {
    const result = await this.#request(context, path, method, body, mutation);
    if (!result.ok) return result;
    try {
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(result.bytes),
      );
      const { data } = envelopeSchema.parse(value);
      const access = data.access;
      if (
        access.user_id !== context.active.userId ||
        access.tenant !== context.selection.tenant ||
        access.profile_id !== context.selection.profile ||
        !sameAccessRevision(
          {
            policyRevision: access.policy_revision,
            accessRevision: access.access_revision ?? undefined,
          },
          context.active,
        )
      )
        return changed();
      return { ok: true, value: data };
    } catch {
      return apiFailure(
        mutation ? 'outcome_unknown' : 'invalid_response',
        mutation
          ? '저장 응답을 확인하지 못했습니다. 같은 내용과 요청으로 다시 확인해 주세요.'
          : '템플릿 응답 형식을 확인할 수 없습니다.',
      );
    }
  }

  /** 목록에는 지침 전체나 파일 바이트를 포함하지 않습니다. */
  async list(request: TemplateSession): Promise<TemplateListResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#json(context, '');
    if (!result.ok) return result;
    try {
      const page = z
        .object({
          items: z.array(z.unknown()),
          complete: z.boolean(),
          truncated: z.boolean(),
        })
        .parse(result.value);
      return {
        ok: true,
        data: {
          ...page,
          items: page.items.map(
            (item: unknown): z.infer<typeof templateSummarySchema> =>
              templateSummarySchema.parse(metadata(item)),
          ),
        },
      };
    } catch {
      return apiFailure(
        'invalid_response',
        '템플릿 목록을 확인할 수 없습니다.',
      );
    }
  }

  /** 현재 판본과 요청 당시 고정 판본을 구별해 읽습니다. */
  async read(request: TemplateReadRequest): Promise<TemplateDetailResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const result = await this.#json(
      context,
      `/${request.templateId}${request.revision ? `/versions/${request.revision}` : ''}`,
    );
    return this.#detail(result, request.templateId, request.revision);
  }

  /** 잘못된 대상 응답을 성공으로 전달하지 않습니다. */
  #detail(
    result: JsonResult,
    id?: string,
    revision?: string,
    mutation: boolean = false,
  ): TemplateDetailResult {
    if (!result.ok) return result;
    try {
      const data = templateDetailSchema.parse({
        template: metadata(result.value.template),
        generation: result.value.generation,
      });
      if (
        (id && data.template.id !== id) ||
        (revision && data.template.revision !== revision)
      )
        return changed();
      return { ok: true, data };
    } catch {
      return apiFailure(
        mutation ? 'outcome_unknown' : 'invalid_response',
        mutation
          ? '저장 응답을 확인하지 못했습니다. 같은 내용과 요청으로 다시 확인해 주세요.'
          : '템플릿 조회 결과를 확인할 수 없습니다.',
      );
    }
  }

  /** 선택한 원본 바이트를 한 번 읽고 경로 대신 불투명한 참조만 공개합니다. */
  async chooseFile(
    request: TemplateChooseFileRequest,
    parent?: BrowserWindow,
  ): Promise<TemplateFileResult> {
    if (this.#choosing)
      return apiFailure(
        'template_busy',
        '열린 파일 선택을 먼저 완료해 주세요.',
      );
    this.#choosing = true;
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      const { dialog } = await import('electron');
      const options = {
        title: '템플릿 파일 선택',
        properties: ['openFile'] satisfies Array<'openFile'>,
      };
      const selection = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      const path = selection.filePaths[0];
      if (selection.canceled || !path)
        return apiFailure('cancelled', '파일 선택을 취소했습니다.');
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES)
          return apiFailure(
            'template_limit',
            '20 MiB 이하의 일반 파일을 선택해 주세요.',
          );
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
          const part = await file.read(
            buffer,
            total,
            buffer.length - total,
            null,
          );
          if (!part.bytesRead) break;
          total += part.bytesRead;
        }
        if (total > MAX_BYTES)
          return apiFailure(
            'template_limit',
            '템플릿 파일은 20 MiB 이하여야 합니다.',
          );
        return this.#select(
          context,
          basename(path),
          buffer.subarray(0, total),
          request.previousFileId,
        );
      } finally {
        await file.close();
      }
    } catch {
      return apiFailure(
        'file_read_failed',
        '템플릿 파일을 읽지 못했습니다. 원본 파일을 확인해 주세요.',
      );
    } finally {
      this.#choosing = false;
    }
  }

  /** 웹 전송도 네이티브 선택과 같은 바이트·범위 검사를 거칩니다. */
  async selectBytes(
    request: TemplateSession,
    filename: string,
    bytes: Uint8Array,
  ): Promise<TemplateFileResult> {
    const context = await this.#context(request, true);
    if ('ok' in context) return context;
    return this.#select(context, filename, bytes);
  }

  /** 선택 자료 수를 제한하며 scope가 바뀐 파일은 다시 사용하지 않습니다. */
  #select(
    context: AnalysisContext,
    filename: string,
    bytes: Uint8Array,
    previousFileId?: string,
  ): TemplateFileResult {
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    const parsed = templateFileSchema.safeParse({
      fileId: randomUUID().replaceAll('-', ''),
      filename,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (!parsed.success)
      return apiFailure(
        'invalid_file',
        '파일 이름과 20 MiB 크기 제한을 확인해 주세요.',
      );
    if (previousFileId) this.#selected.delete(previousFileId);
    if (this.#selected.size >= 8)
      return apiFailure(
        'template_selection_limit',
        '열린 템플릿 초안의 파일을 먼저 저장해 주세요.',
      );
    this.#selected.set(parsed.data.fileId, {
      info: parsed.data,
      bytes: Uint8Array.from(bytes),
      context,
    });
    return { ok: true, data: parsed.data };
  }

  /** 같은 요청 ID·기준 판본으로 재시도할 수 있도록 선택 바이트를 유지합니다. */
  async save(request: TemplateSaveRequest): Promise<TemplateDetailResult> {
    const context = await this.#context(request, true);
    if ('ok' in context) return context;
    const selected = request.fileId
      ? this.#selected.get(request.fileId)
      : undefined;
    if (
      request.fileId &&
      (!selected || !this.#connection.isAnalysisCurrent(selected.context))
    )
      return apiFailure(
        'file_selection_expired',
        '템플릿 파일을 다시 선택해 주세요. 입력한 지침은 유지됩니다.',
      );
    const form = new FormData();
    form.set('request_id', request.requestId);
    form.set('name', request.name);
    form.set('instructions', request.instructions);
    form.set('profile', context.selection.profile);
    if (request.expectedRevision)
      form.set('expected_revision', request.expectedRevision);
    if (selected)
      form.set(
        'file',
        new Blob([Uint8Array.from(selected.bytes)]),
        selected.info.filename,
      );
    const result = this.#detail(
      await this.#json(
        context,
        request.templateId ? `/${request.templateId}` : '',
        request.templateId ? 'PUT' : 'POST',
        form,
        true,
      ),
      request.templateId,
      undefined,
      true,
    );
    if (result.ok && request.fileId) this.#selected.delete(request.fileId);
    return result;
  }

  /** 보관은 선택 목록에서만 제외하며 과거 요청의 판본은 남깁니다. */
  async archive(
    request: TemplateArchiveRequest,
  ): Promise<TemplateDetailResult> {
    const context = await this.#context(request, true);
    if ('ok' in context) return context;
    return this.#detail(
      await this.#json(
        context,
        `/${request.templateId}/archive`,
        'POST',
        {
          request_id: request.requestId,
          expected_revision: request.expectedRevision,
          profile: context.selection.profile,
        },
        true,
      ),
      request.templateId,
      undefined,
      true,
    );
  }

  /** 고정 판본을 실제로 렌더한 뒤에만 완료 파일 정보를 돌려줍니다. */
  async prepareResult(
    request: TemplatePrepareResultRequest,
  ): Promise<TemplatePreparedResultResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const detail = await this.read(request);
    if (!detail.ok) return detail;
    const rendered = await this.#request(
      context,
      `/${request.templateId}/versions/${request.revision}/render`,
      'POST',
      { content: request.content, profile: context.selection.profile },
    );
    if (!rendered.ok) return rendered;
    if (
      rendered.headers.get('x-template-revision') !== request.revision ||
      rendered.headers.get('x-content-sha256') !==
        createHash('sha256').update(rendered.bytes).digest('hex')
    )
      return apiFailure(
        'file_integrity',
        '생성된 파일의 판본과 무결성을 확인할 수 없습니다.',
      );
    const extension = extname(detail.data.template.filename);
    const filename = `${basename(detail.data.template.filename, extension).slice(0, 180)}-결과${extension}`;
    const info: TemplatePreparedResult = {
      resultId: randomUUID().replaceAll('-', ''),
      filename,
      sizeBytes: rendered.bytes.byteLength,
      sha256: createHash('sha256').update(rendered.bytes).digest('hex'),
    };
    if (!this.#connection.isAnalysisCurrent(context)) return changed();
    if (this.#prepared.size >= 8) {
      const oldest = this.#prepared.keys().next().value;
      if (oldest) this.#prepared.delete(oldest);
    }
    this.#prepared.set(info.resultId, {
      context,
      bytes: rendered.bytes,
      info,
      templateId: request.templateId,
      revision: request.revision,
    });
    return { ok: true, data: info };
  }

  /** 요청한 고정 파일의 지문을 대조하고 원본을 새 위치로 내려받습니다. */
  async downloadOriginal(
    request: TemplateOriginalRequest,
    parent?: BrowserWindow,
  ): Promise<TemplateDownloadResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const detail = await this.read(request);
    if (!detail.ok) return detail;
    const result = await this.#request(
      context,
      `/${request.templateId}/versions/${request.revision}/file`,
    );
    if (!result.ok) return result;
    if (
      result.bytes.byteLength !== detail.data.template.sizeBytes ||
      createHash('sha256').update(result.bytes).digest('hex') !==
        detail.data.template.sha256
    )
      return apiFailure(
        'file_integrity',
        '원본 파일의 무결성을 확인할 수 없습니다.',
      );
    return this.#download(
      request,
      context,
      detail.data.template.filename,
      result.bytes,
      parent,
    );
  }

  /** 파일 생성과 내려받기를 나누고 권한 철회를 저장 직전까지 확인합니다. */
  async downloadResult(
    request: TemplateDownloadResultRequest,
    parent?: BrowserWindow,
  ): Promise<TemplateDownloadResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const file = this.#prepared.get(request.resultId);
    if (!file || !this.#connection.isAnalysisCurrent(file.context))
      return apiFailure(
        'result_expired',
        '결과 파일을 다시 준비한 뒤 내려받아 주세요.',
      );
    const current = await this.read({
      ...request,
      templateId: file.templateId,
      revision: file.revision,
    });
    if (!current.ok) return current;
    return this.#download(
      request,
      context,
      file.info.filename,
      file.bytes,
      parent,
    );
  }

  /** 완성된 파일만 새 경로에 공개하고 기존 파일을 덮어쓰지 않습니다. */
  async #download(
    request: TemplateSession,
    context: AnalysisContext,
    filename: string,
    bytes: Uint8Array,
    parent?: BrowserWindow,
  ): Promise<TemplateDownloadResult> {
    if (this.#downloading)
      return apiFailure('download_busy', '열린 저장 창을 먼저 완료해 주세요.');
    this.#downloading = true;
    try {
      const { dialog } = await import('electron');
      const options = { title: '템플릿 파일 저장', defaultPath: filename };
      const destination = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (destination.canceled || !destination.filePath)
        return { ok: true, data: { started: false } };
      const refreshed = await this.#context(request);
      if ('ok' in refreshed) return refreshed;
      const warning = await saveMarkdownExport(
        destination.filePath,
        bytes,
        (): boolean =>
          this.#connection.isAnalysisCurrent(context) &&
          (!parent || !parent.isDestroyed()),
      );
      return { ok: true, data: { started: true, ...warning } };
    } catch {
      return apiFailure(
        'file_save_failed',
        '파일을 저장하지 못했습니다. 기존 파일과 다른 이름이나 위치로 다시 시도해 주세요.',
      );
    } finally {
      this.#downloading = false;
    }
  }
}
