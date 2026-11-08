import { sameAccessRevision } from '@contracts/connection.contract';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';

type ChooseOriginal = (
  parent: BrowserWindow | undefined,
  options: OpenDialogOptions,
) => Promise<OpenDialogReturnValue>;
/** 네이티브 선택 창은 main에서만 열며 시험에서는 선택 경계만 주입합니다. */
async function chooseOriginal(
  parent: BrowserWindow | undefined,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const { dialog } = await import('electron');
  return parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options);
}
import { z } from 'zod';
import { parseAccessContext } from '@contracts/connection.contract';
import type {
  WorkspaceMembership,
  WorkspaceProfile,
} from '@contracts/connection.contract';
import { MAX_SOURCE_BYTES } from '@contracts/documents.contract';
import type { SourceFormat } from '@contracts/documents.contract';
import type {
  ChooseSourceFileResult,
  SourceFile,
  SourceReceiptRequest,
  SourceRegistrationRecord,
  SourceRegistrationRequest,
  SourceRegistrationResult,
  SourceSessionRequest,
  SourceVersionsRequest,
  SourceVersionsResult,
} from '@contracts/sources.contract';
import { parseSourceVersionsResponse } from '@contracts/sources.contract';
import { apiFailure, readApiJson } from './readApi';
import type { ApiFailure } from './readApi';
import { registrationUnknown, writeSourceApi } from './writeSourceApi';
import {
  isTextSource,
  sourceFileFormat,
  sourceMediaType,
  sourceSignatureMatches,
  sourceText,
} from './sourceOriginal';

export type RegistrationSession = {
  connectionId: string;
  serverUrl: string;
  userId: string;
  policyRevision: string;
  accessRevision?: string;
  workspaces: WorkspaceMembership[];
  selection: { tenant: string; profile: string };
  token: string;
  generation: number;
};
type SelectedFile = SourceFile & { bytes: Buffer; scope: string };
type PreparedSource = {
  body: FormData | string;
  format: SourceFormat;
  sourceSha256: string;
  sizeBytes: number;
  fingerprint: string;
};
type Attempt = {
  scope: string;
  title: string;
  format: SourceFormat;
  sourceSha256: string;
  sizeBytes: number;
  fingerprint: string;
  state: 'inflight' | 'uncertain' | 'complete' | 'pending_reconcile';
  result: SourceRegistrationRecord | null;
  sourceId: string | null;
};
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: hash,
  access_revision: z
    .string()
    .min(1)
    .nullish()
    .transform(
      (value: string | null | undefined): string | undefined =>
        value ?? undefined,
    ),
});
const receiptSchema = z.object({
  request_id: identifier,
  source_id: identifier,
  source_version: identifier,
  source_sha256: hash,
  size_bytes: z.number().int().min(0).max(MAX_SOURCE_BYTES),
  registration_revision: hash,
  actor: accessSchema,
  storage_status: z.literal('stored'),
  analysis_status: z.literal('not_started'),
});
const responseSchema = z.object({
  data: z.object({
    request_id: identifier,
    state: z.enum(['complete', 'pending_reconcile']),
    source_id: identifier,
    source_version: identifier,
    source_sha256: hash,
    size_bytes: z.number().int().min(0).max(MAX_SOURCE_BYTES),
    registration_revision: hash.nullable(),
    receipt: receiptSchema.nullable(),
    cleanup_failures: z.array(z.record(z.string(), z.unknown())).max(10),
    replayed: z.boolean(),
    access: accessSchema,
  }),
  meta: z.object({ trace_id: identifier }),
});

/** 파일과 등록 요청은 같은 사용자·연결·선택 범위에서만 다시 사용할 수 있습니다. */
function scopeKey(session: RegistrationSession): string {
  return JSON.stringify([
    session.connectionId,
    session.serverUrl,
    session.userId,
    session.accessRevision ?? session.policyRevision,
    session.selection.tenant,
    session.selection.profile,
  ]);
}

/** 영수증의 소유권은 관점/정책 revision과 별개이며 같은 서버·사용자·tenant에 묶입니다. */
function ownerKey(session: RegistrationSession): string {
  return JSON.stringify([
    session.connectionId,
    session.serverUrl,
    session.userId,
    session.selection.tenant,
  ]);
}

/** 공개 오류에는 로컬 경로/파일 내용/원격 오류 원문을 넣지 않습니다. */
function sessionChanged(): ApiFailure {
  return apiFailure(
    'connection_changed',
    '연결 또는 작업 공간이 변경되었습니다. 현재 선택을 다시 확인해 주세요.',
  );
}

/** 파일명만 받아 경로·제어 문자와 지원하지 않는 확장자를 거부합니다. */
function selectedSourceFormat(filename: string): SourceFormat | null {
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    /[\\/:]/.test(filename) ||
    Array.from(filename).some(
      (character: string): boolean =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  return sourceFileFormat(filename);
}

/** 원본 등록은 main의 파일 snapshot·요청 영수증만 소유하고 화면 상태는 보관하지 않습니다. */
export class SourceRegistrationService {
  #file: SelectedFile | null = null;
  #choosing = false;
  #busy = false;
  #controllers = new Set<AbortController>();
  #attempts = new Map<string, Attempt>();
  #session: () => RegistrationSession | null;
  #invalidate: (failure: ApiFailure) => void;

  #choose: ChooseOriginal;

  constructor(
    session: () => RegistrationSession | null,
    invalidate: (failure: ApiFailure) => void,
    choose: ChooseOriginal = chooseOriginal,
  ) {
    this.#choose = choose;
    this.#session = session;
    this.#invalidate = invalidate;
  }

  /** 연결/선택 변경은 전송과 파일 참조를 취소하되 미확정 영수증 근거를 지우지 않습니다. */
  cancel(): void {
    for (const controller of this.#controllers) controller.abort();
    this.#file = null;
  }

  /** await 뒤에는 선택뿐 아니라 연결 세대도 대조해 이전 완료를 차단합니다. */
  #current(session: RegistrationSession): boolean {
    const current = this.#session();
    return (
      current !== null &&
      current.generation === session.generation &&
      scopeKey(current) === scopeKey(session)
    );
  }

  /** 서버의 최신 소속과 권한을 재조회하고 선택 관점/정책이 바뀌면 진행하지 않습니다. */
  async #authorize(
    session: RegistrationSession,
    write: boolean,
    controller: AbortController,
  ): Promise<WorkspaceMembership | ApiFailure> {
    const result = await readApiJson(
      `${session.serverUrl}access-context`,
      session.token,
      controller,
    );
    if (!this.#current(session)) return sessionChanged();
    if (!result.ok) {
      this.#invalidate(result);
      return result;
    }
    try {
      const context = parseAccessContext(result.value);
      if (context.userId !== session.userId) {
        const failure = apiFailure(
          'subject_changed',
          '인증 사용자가 변경되었습니다. 새로 연결해 주세요.',
        );
        this.#invalidate(failure);
        return failure;
      }
      const workspace = context.workspaces.find(
        (item: WorkspaceMembership): boolean =>
          item.id === session.selection.tenant,
      );
      if (
        !sameAccessRevision(context, session) ||
        !workspace ||
        !workspace.profiles.some(
          (profile: WorkspaceProfile): boolean =>
            profile.id === session.selection.profile,
        ) ||
        !workspace.permissions.includes('read')
      ) {
        const failure = apiFailure(
          'scope_changed',
          '권한 또는 조회 범위가 변경되었습니다. 작업 공간을 다시 선택해 주세요.',
        );
        this.#invalidate(failure);
        return failure;
      }
      if (write && !workspace.permissions.includes('source_write'))
        return apiFailure(
          'source_write_required',
          '이 작업 공간에 원본을 등록할 권한이 없습니다.',
        );
      return workspace;
    } catch {
      return apiFailure(
        'invalid_response',
        '서버의 원본 등록 권한을 확인할 수 없습니다.',
      );
    }
  }

  /** 네이티브 선택으로 받은 일반 파일만 제한 크기로 읽어 불변 메모리 snapshot을 만듭니다. */
  async chooseFile(
    request: SourceSessionRequest,
    parent?: BrowserWindow,
  ): Promise<ChooseSourceFileResult> {
    const session = this.#session();
    if (!session || session.connectionId !== request.connectionId)
      return sessionChanged();
    if (this.#choosing || this.#busy)
      return apiFailure(
        'registration_busy',
        '진행 중인 원본 작업을 기다려 주세요.',
      );
    this.#choosing = true;
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const allowed = await this.#authorize(session, true, controller);
      if ('ok' in allowed) return allowed;
      const selected = await this.#choose(parent, {
        title: '원본 파일 선택',
        properties: ['openFile'],
        filters: [
          {
            name: '문서 · 이미지 원본',
            extensions: [
              'md',
              'txt',
              'pdf',
              'xlsx',
              'docx',
              'png',
              'jpg',
              'jpeg',
              'gif',
              'webp',
              'bmp',
              'tif',
              'tiff',
            ],
          },
        ],
      });
      if (!this.#current(session)) return sessionChanged();
      if (selected.canceled || selected.filePaths.length === 0)
        return { ok: true, data: null };
      const path = selected.filePaths[0];
      if (!path) return { ok: true, data: null };
      const filename = basename(path);
      const format = selectedSourceFormat(filename);
      if (format === null)
        return apiFailure(
          'unsupported_source',
          'MD·TXT·PDF·XLSX·DOCX 또는 PNG·JPEG·GIF·WebP·BMP·TIFF 파일을 선택해 주세요.',
        );
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile())
          return apiFailure(
            'invalid_source',
            '일반 파일만 원본으로 등록할 수 있습니다.',
          );
        if (stat.size > MAX_SOURCE_BYTES)
          return apiFailure(
            'source_limit',
            '원본 파일은 20 MiB 이내여야 합니다.',
          );
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
          const chunk = Buffer.alloc(65536);
          const read = await file.read(chunk, 0, chunk.byteLength, null);
          if (!this.#current(session)) return sessionChanged();
          if (read.bytesRead === 0) break;
          total += read.bytesRead;
          if (total > MAX_SOURCE_BYTES)
            return apiFailure(
              'source_limit',
              '원본 파일은 20 MiB 이내여야 합니다.',
            );
          const value = chunk.subarray(0, read.bytesRead);
          chunks.push(value);
        }
        bytes = Buffer.concat(chunks, total);
      } finally {
        await file.close();
      }
      return this.#retainFile(session, filename, bytes);
    } catch {
      return apiFailure(
        'invalid_source',
        '파일을 읽을 수 없습니다. 지원되는 일반 문서·이미지 파일인지, 텍스트는 UTF-8인지 확인해 주세요.',
      );
    } finally {
      this.#controllers.delete(controller);
      this.#choosing = false;
    }
  }

  /** 브라우저가 전달한 파일은 권한 확인 전에 복사해 대기 중 바이트 변경을 차단합니다. */
  async acceptFile(
    request: SourceSessionRequest,
    filename: string,
    bytes: Uint8Array,
  ): Promise<ChooseSourceFileResult> {
    const session = this.#session();
    if (!session || session.connectionId !== request.connectionId)
      return sessionChanged();
    if (this.#choosing || this.#busy)
      return apiFailure(
        'registration_busy',
        '진행 중인 원본 작업을 기다려 주세요.',
      );
    if (bytes.byteLength > MAX_SOURCE_BYTES)
      return apiFailure('source_limit', '원본 파일은 20 MiB 이내여야 합니다.');
    this.#choosing = true;
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const snapshot = Buffer.from(bytes);
      const allowed = await this.#authorize(session, true, controller);
      if ('ok' in allowed) return allowed;
      return this.#retainFile(session, filename, snapshot);
    } catch {
      return apiFailure(
        'invalid_source',
        '파일을 읽을 수 없습니다. 지원되는 일반 문서·이미지 파일인지, 텍스트는 UTF-8인지 확인해 주세요.',
      );
    } finally {
      this.#controllers.delete(controller);
      this.#choosing = false;
    }
  }

  /** 플랫폼별로 읽은 바이트에도 같은 형식·UTF-8·크기·세대 검사를 적용합니다. */
  #retainFile(
    session: RegistrationSession,
    filename: string,
    bytes: Buffer,
  ): ChooseSourceFileResult {
    const format = selectedSourceFormat(filename);
    if (format === null)
      return apiFailure(
        'unsupported_source',
        'MD·TXT·PDF·XLSX·DOCX 또는 PNG·JPEG·GIF·WebP·BMP·TIFF 파일을 선택해 주세요.',
      );
    if (bytes.byteLength > MAX_SOURCE_BYTES)
      return apiFailure('source_limit', '원본 파일은 20 MiB 이내여야 합니다.');
    if (!sourceSignatureMatches(format, bytes))
      return apiFailure(
        'unsupported_source',
        '파일 내용이 선택한 원본 형식과 일치하지 않습니다.',
      );
    if (isTextSource(format)) sourceText(bytes);
    if (!this.#current(session)) return sessionChanged();
    const data: SourceFile = {
      fileId: randomUUID().replaceAll('-', ''),
      filename,
      format,
      sizeBytes: bytes.byteLength,
    };
    this.#file = { ...data, bytes, scope: scopeKey(session) };
    return { ok: true, data };
  }

  /** 전송할 내용의 지문을 고정하고 파일 경로/바이트를 renderer로 되돌리지 않습니다. */
  #prepare(
    request: SourceRegistrationRequest,
    session: RegistrationSession,
  ): PreparedSource | ApiFailure {
    let body: FormData | string;
    let format: SourceFormat;
    let bytes: Buffer;
    let filename: string | null = null;
    if (request.kind === 'file') {
      const file = this.#file;
      if (
        !file ||
        file.fileId !== request.fileId ||
        file.scope !== scopeKey(session)
      )
        return apiFailure('file_unavailable', '파일을 다시 선택해 주세요.');
      format = file.format;
      filename = file.filename;
      bytes = file.bytes;
      body = new FormData();
      body.set('request_id', request.requestId);
      body.set('title', request.title);
      if (request.target)
        body.set(
          'expected_registration_revision',
          request.target.expectedRegistrationRevision,
        );
      body.set(
        'file',
        new Blob([new Uint8Array(bytes)], {
          type: sourceMediaType(format),
        }),
        filename,
      );
    } else {
      if (
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          request.content,
        )
      )
        return apiFailure(
          'invalid_source',
          '본문에 올바르지 않은 문자가 있습니다.',
        );
      bytes = Buffer.from(request.content, 'utf8');
      if (bytes.byteLength > MAX_SOURCE_BYTES)
        return apiFailure(
          'source_limit',
          '원본은 UTF-8 20 MiB 이내여야 합니다.',
        );
      format = request.format;
      body = JSON.stringify({
        request_id: request.requestId,
        title: request.title,
        format,
        content: request.content,
        ...(request.target
          ? {
              expected_registration_revision:
                request.target.expectedRegistrationRevision,
            }
          : {}),
      });
      if (Buffer.byteLength(body) > 24 * 1024 * 1024)
        return apiFailure(
          'source_transport_limit',
          '입력 내용이 전송 한도를 초과했습니다. 같은 내용을 파일로 등록해 주세요.',
        );
    }
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          kind: request.kind,
          title: request.title,
          format,
          filename,
          sourceSha256,
          sizeBytes: bytes.byteLength,
          target: request.target || null,
        }),
      )
      .digest('hex');
    return {
      body,
      format,
      sourceSha256,
      sizeBytes: bytes.byteLength,
      fingerprint,
    };
  }

  /** 응답은 현재 주체의 기본 관점과 고정 입력/영수증의 정확한 원본을 함께 대조합니다. */
  #record(
    value: unknown,
    requestId: string,
    attempt: Attempt,
    session: RegistrationSession,
    workspace: WorkspaceMembership,
  ): SourceRegistrationRecord {
    const { data } = responseSchema.parse(value);
    const profile = workspace.profiles.find(
      (item: WorkspaceProfile): boolean => item.id === workspace.defaultProfile,
    );
    if (
      !profile ||
      data.request_id !== requestId ||
      data.source_sha256 !== attempt.sourceSha256 ||
      data.size_bytes !== attempt.sizeBytes ||
      (attempt.sourceId !== null && data.source_id !== attempt.sourceId) ||
      data.access.user_id !== session.userId ||
      data.access.tenant !== session.selection.tenant ||
      !sameAccessRevision(
        {
          policyRevision: data.access.policy_revision,
          accessRevision: data.access.access_revision,
        },
        session,
      ) ||
      data.access.profile_id !== profile.id ||
      data.access.domain !== profile.domain ||
      data.access.viewpoint !== profile.viewpoint
    )
      throw new Error('invalid_registration');
    const base = {
      connectionId: session.connectionId,
      requestId,
      cleanupWarningCount: data.cleanup_failures.length,
      access: {
        userId: data.access.user_id,
        tenant: data.access.tenant,
        profileId: data.access.profile_id,
        domain: data.access.domain,
        viewpoint: data.access.viewpoint,
        policyRevision: data.access.policy_revision,
        ...(data.access.access_revision
          ? { accessRevision: data.access.access_revision }
          : {}),
      },
    };
    if (data.state === 'pending_reconcile') {
      if (data.registration_revision !== null || data.receipt !== null)
        throw new Error('invalid_registration');
      return { ...base, state: 'pending_reconcile', item: null };
    }
    const receipt = data.receipt;
    if (
      !receipt ||
      data.registration_revision === null ||
      receipt.request_id !== requestId ||
      receipt.source_id !== data.source_id ||
      receipt.source_version !== data.source_version ||
      receipt.source_sha256 !== data.source_sha256 ||
      receipt.size_bytes !== data.size_bytes ||
      receipt.registration_revision !== data.registration_revision ||
      receipt.actor.user_id !== session.userId ||
      receipt.actor.tenant !== session.selection.tenant
    )
      throw new Error('invalid_receipt');
    return {
      ...base,
      state: 'complete',
      item: {
        kind: 'source',
        sourceId: data.source_id,
        title: attempt.title,
        sourceVersion: data.source_version,
        sourceSha256: data.source_sha256,
        sizeBytes: data.size_bytes,
        format: attempt.format,
        registrationRevision: data.registration_revision,
        linkedDocumentCount: 0,
        analysisStatus: 'not_started',
      },
    };
  }

  /** 한 요청은 한 번만 POST하고 재호출은 완료 결과 또는 영수증 확인 안내를 반환합니다. */
  async register(
    request: SourceRegistrationRequest,
  ): Promise<SourceRegistrationResult> {
    const session = this.#session();
    if (!session || session.connectionId !== request.connectionId)
      return sessionChanged();
    const expected = request.expectedScope;
    if (
      !expected ||
      expected.userId !== session.userId ||
      expected.tenant !== session.selection.tenant ||
      expected.profileId !== session.selection.profile ||
      !sameAccessRevision(expected, session)
    )
      return apiFailure(
        'scope_changed',
        '등록 초안의 작업 공간 또는 조회 설정이 변경되었습니다. 현재 작업 공간에서 다시 확인해 주세요.',
      );
    if (this.#busy || this.#choosing)
      return apiFailure(
        'registration_busy',
        '진행 중인 원본 작업을 기다려 주세요.',
      );
    const prepared = this.#prepare(request, session);
    if ('ok' in prepared) return prepared;
    const prior = this.#attempts.get(request.requestId);
    if (
      prior &&
      (prior.scope !== ownerKey(session) ||
        prior.fingerprint !== prepared.fingerprint)
    )
      return apiFailure(
        'request_conflict',
        '같은 등록 요청의 내용이 다릅니다. 기존 등록 상태를 확인해 주세요.',
      );
    if (prior)
      return this.receipt({
        connectionId: request.connectionId,
        requestId: request.requestId,
      });
    const unresolved = [...this.#attempts.entries()].find(
      ([, item]: [string, Attempt]): boolean =>
        item.scope === ownerKey(session) && item.state !== 'complete',
    );
    if (unresolved)
      return {
        ok: false,
        error: {
          code: 'registration_unresolved',
          message: '이전 원본의 등록 상태를 먼저 확인해 주세요.',
          requestId: unresolved[0],
        },
      };
    this.#busy = true;
    const controller = new AbortController();
    this.#controllers.add(controller);
    let attempt: Attempt | null = null;
    try {
      const allowed = await this.#authorize(session, true, controller);
      if ('ok' in allowed) return allowed;
      attempt = {
        scope: ownerKey(session),
        title: request.title,
        format: prepared.format,
        sourceSha256: prepared.sourceSha256,
        sizeBytes: prepared.sizeBytes,
        fingerprint: prepared.fingerprint,
        state: 'inflight',
        result: null,
        sourceId: request.target ? request.target.sourceId : null,
      };
      this.#attempts.set(request.requestId, attempt);
      const result = await writeSourceApi(
        `${session.serverUrl}tenants/${encodeURIComponent(session.selection.tenant)}/sources${request.target ? `/${request.target.sourceId}/versions` : ''}`,
        session.token,
        prepared.body,
        controller,
      );
      if (!this.#current(session)) {
        attempt.state = 'uncertain';
        return sessionChanged();
      }
      if (!result.ok) {
        if (result.error.code === 'outcome_unknown')
          attempt.state = 'uncertain';
        else this.#attempts.delete(request.requestId);
        this.#invalidate(result);
        return result;
      }
      const data = this.#record(
        result.value,
        request.requestId,
        attempt,
        session,
        allowed,
      );
      attempt.state = data.state;
      attempt.result = data;
      // 완료된 작은 영수증만 제한 개수 보존하며 미확정 요청은 정리하지 않습니다.
      if (this.#attempts.size > 20) {
        const old = [...this.#attempts.entries()].find(
          ([key, item]: [string, Attempt]): boolean =>
            key !== request.requestId && item.state === 'complete',
        );
        if (old) this.#attempts.delete(old[0]);
      }
      return { ok: true, data };
    } catch {
      if (attempt) attempt.state = 'uncertain';
      return registrationUnknown();
    } finally {
      this.#controllers.delete(controller);
      this.#busy = false;
    }
  }

  /** 미확정/조정 대기는 같은 본인 요청의 GET으로만 확인하고 쓰기를 재전송하지 않습니다. */
  async receipt(
    request: SourceReceiptRequest,
  ): Promise<SourceRegistrationResult> {
    const session = this.#session();
    if (!session || session.connectionId !== request.connectionId)
      return sessionChanged();
    const attempt = this.#attempts.get(request.requestId);
    if (!attempt || attempt.scope !== ownerKey(session))
      return registrationUnknown();
    if (this.#busy || this.#choosing)
      return apiFailure(
        'registration_busy',
        '진행 중인 원본 작업을 기다려 주세요.',
      );
    this.#busy = true;
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const allowed = await this.#authorize(session, false, controller);
      if ('ok' in allowed) return allowed;
      const result = await readApiJson(
        `${session.serverUrl}tenants/${encodeURIComponent(session.selection.tenant)}/requests/${request.requestId}`,
        session.token,
        controller,
      );
      if (!this.#current(session)) return sessionChanged();
      if (!result.ok) {
        this.#invalidate(result);
        return result.error.status === 401 || result.error.status === 403
          ? result
          : registrationUnknown(result.error.traceId);
      }
      const data = this.#record(
        result.value,
        request.requestId,
        attempt,
        session,
        allowed,
      );
      attempt.result = data;
      attempt.state = data.state;
      return { ok: true, data };
    } catch {
      return registrationUnknown();
    } finally {
      this.#controllers.delete(controller);
      this.#busy = false;
    }
  }

  /** 원본의 전체 불변 판본을 현재 read 범위에서 읽고 선택 관점과 응답을 대조합니다. */
  async versions(
    request: SourceVersionsRequest,
  ): Promise<SourceVersionsResult> {
    const session = this.#session();
    if (!session || session.connectionId !== request.connectionId)
      return sessionChanged();
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const allowed = await this.#authorize(session, false, controller);
      if ('ok' in allowed) return allowed;
      const url = new URL(
        `${session.serverUrl}tenants/${encodeURIComponent(session.selection.tenant)}/sources/${request.sourceId}`,
      );
      url.searchParams.set('profile', session.selection.profile);
      const result = await readApiJson(url.href, session.token, controller);
      if (!this.#current(session)) return sessionChanged();
      if (!result.ok) {
        this.#invalidate(result);
        return result;
      }
      const data = parseSourceVersionsResponse(
        result.value,
        session.connectionId,
      );
      const profile = allowed.profiles.find(
        (item: WorkspaceProfile): boolean =>
          item.id === session.selection.profile,
      );
      if (data.sourceId !== request.sourceId)
        return apiFailure(
          'invalid_response',
          '요청한 원본과 판본 목록이 일치하지 않습니다.',
        );
      if (
        !profile ||
        data.access.userId !== session.userId ||
        data.access.tenant !== session.selection.tenant ||
        data.access.profileId !== profile.id ||
        data.access.domain !== profile.domain ||
        data.access.viewpoint !== profile.viewpoint ||
        !sameAccessRevision(data.access, session)
      ) {
        const failure = apiFailure(
          'scope_changed',
          '판본 조회 중 권한 또는 조회 범위가 변경되었습니다. 작업 공간을 다시 확인해 주세요.',
        );
        this.#invalidate(failure);
        return failure;
      }
      return { ok: true, data };
    } catch {
      return apiFailure(
        'invalid_response',
        '원본 판본 목록을 확인할 수 없습니다. 잠시 후 다시 조회해 주세요.',
      );
    } finally {
      this.#controllers.delete(controller);
    }
  }
}
