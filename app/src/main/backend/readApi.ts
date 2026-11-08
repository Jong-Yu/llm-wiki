import type { ConnectionResult } from '@contracts/connection.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import type { SourcePreviewRequest } from '@contracts/documents.contract';
import { MAX_SOURCE_BYTES } from '@contracts/documents.contract';
import {
  recordServerFailure,
  recordServerResponse,
} from './serverReachability';
import {
  sourceContentType,
  sourceMediaType,
  sourceSignatureMatches,
} from './sourceOriginal';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
export type ApiFailure = Extract<ConnectionResult, { ok: false }>;
export type ReadApiResult = { ok: true; value: unknown } | ApiFailure;
type ReadApiOptions = {
  maxResponseBytes?: number;
  method?: 'GET' | 'POST';
  body?: unknown;
};

type ScopedEnvelope = {
  data: {
    access: {
      user_id: string;
      tenant: string;
      profile_id?: string;
      policy_revision: string;
      access_revision?: string | null;
    };
  };
};
type ScopedApiOptions = {
  schema: z.ZodType<ScopedEnvelope>;
  changed: () => ApiFailure;
  accessChanged?: () => ApiFailure;
  invalidMessage: string;
  /** 질문은 GET query/POST body, 비교는 두 메서드 모두 query에도 관점을 고정합니다. */
  profile?: 'get-query' | 'query';
  body?: Record<string, unknown>;
  maxResponseBytes?: number;
};

/** 예상 범위는 권한 부여가 아니라 화면의 오래된 선택을 거부하는 비교값입니다. */
export function matchesExpectedScope(
  scope: WorkspaceScope,
  context: AnalysisContext,
): boolean {
  return (
    scope.userId === context.active.userId &&
    scope.tenant === context.selection.tenant &&
    scope.profileId === context.selection.profile &&
    sameAccessRevision(scope, context.active)
  );
}

/** 인증된 요청의 수명·접근 기준을 공통으로 검사하고 서비스별 업무 schema는 유지합니다. */
export async function readScopedApiJson(
  connection: Pick<
    ConnectionService,
    'isAnalysisCurrent' | 'analysisAccessFailure'
  >,
  requests: Set<AbortController>,
  context: AnalysisContext,
  path: string,
  options: ScopedApiOptions,
): Promise<ReadApiResult> {
  if (!connection.isAnalysisCurrent(context)) return options.changed();
  let url = `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/${path}`;
  if (
    options.profile === 'query' ||
    (options.profile && options.body === undefined)
  )
    url += `${url.includes('?') ? '&' : '?'}${new URLSearchParams({ profile: context.selection.profile }).toString()}`;
  const controller = new AbortController();
  requests.add(controller);
  let result: ReadApiResult;
  try {
    result = await readApiJson(url, context.token, controller, {
      maxResponseBytes: options.maxResponseBytes,
      ...(options.body === undefined
        ? {}
        : {
            method: 'POST',
            body: options.profile
              ? { ...options.body, profile: context.selection.profile }
              : options.body,
          }),
    });
  } finally {
    requests.delete(controller);
  }
  if (!connection.isAnalysisCurrent(context)) return options.changed();
  if (!result.ok) {
    connection.analysisAccessFailure(result);
    return result;
  }
  const parsed = options.schema.safeParse(result.value);
  if (!parsed.success)
    return apiFailure('invalid_response', options.invalidMessage);
  const scope = parsed.data.data.access;
  if (
    scope.user_id !== context.active.userId ||
    scope.tenant !== context.selection.tenant ||
    (options.profile && scope.profile_id !== context.selection.profile) ||
    !sameAccessRevision(
      {
        policyRevision: scope.policy_revision,
        accessRevision: scope.access_revision ?? undefined,
      },
      context.active,
    )
  )
    return (options.accessChanged ?? options.changed)();
  return { ok: true, value: parsed.data.data };
}

/** 원격 본문이나 자격 증명을 포함하지 않는 공개 오류 결과를 만듭니다. */
export function apiFailure(
  code: string,
  message: string,
  status?: number,
  traceId?: string,
): ApiFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(status !== undefined ? { status } : {}),
      ...(traceId ? { traceId } : {}),
    },
  };
}

/** 실제 수신 바이트를 제한하며 실패/취소 시 남은 스트림을 닫습니다. */
async function responseBytes(
  response: Response,
  maxResponseBytes: number = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new Error('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch((): void => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** 제한 크기의 UTF-8 JSON만 읽고 잘못된 원문을 오류 메시지에 포함하지 않습니다. */
export async function readApiJsonBody(
  response: Response,
  maxResponseBytes: number = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  ) {
    await response.body?.cancel();
    throw new Error('invalid_response');
  }
  const bytes = await responseBytes(response, maxResponseBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('invalid_response');
  }
}

/** 고정 코드/추적 ID만 확인하며 서버 오류 문구나 details는 반사하지 않습니다. */
function errorMetadata(value: unknown): { code?: string; traceId?: string } {
  if (typeof value !== 'object' || value === null) return {};
  let code: string | undefined;
  let traceId: string | undefined;
  if (
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'code' in value.error &&
    typeof value.error.code === 'string' &&
    /^[a-z0-9_]{1,128}$/.test(value.error.code)
  )
    code = value.error.code;
  if (
    'meta' in value &&
    typeof value.meta === 'object' &&
    value.meta !== null &&
    'trace_id' in value.meta &&
    typeof value.meta.trace_id === 'string' &&
    /^[a-f0-9]{32}$/.test(value.meta.trace_id)
  )
    traceId = value.meta.trace_id;
  return { code, traceId };
}

/** main이 정한 API 주소로만 인증된 GET을 보내며 크기·시간·redirect 제한을 공유합니다. */
async function readApi(
  url: string,
  token: string | null,
  controller: AbortController,
  decode: (response: Response) => Promise<unknown>,
  accept: string,
  options: ReadApiOptions = {},
): Promise<ReadApiResult> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, timeout]);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        Accept: accept,
        ...(options.method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(options.method === 'POST'
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    // 응답 본문이 어떻든 서버에 닿았다는 뜻이라 끊김 판단을 지웁니다.
    recordServerResponse();
    if (
      options.method === 'POST'
        ? ![200, 201, 202].includes(response.status)
        : response.status !== 200
    ) {
      let metadata: ReturnType<typeof errorMetadata> = {};
      try {
        metadata = errorMetadata(await readApiJsonBody(response));
      } catch {
        /* 원격 실패 본문은 응답에 포함하지 않습니다. */
      }
      const { code, traceId } = metadata;
      if (response.status === 401)
        return apiFailure(
          'unauthorized',
          '개인 토큰이 올바르지 않거나 만료되었습니다.',
          401,
          traceId,
        );
      if (response.status === 403)
        return apiFailure(
          'forbidden',
          '선택한 작업 공간의 자료를 조회할 권한이 없습니다.',
          403,
          traceId,
        );
      if (response.status === 404 && code === 'not_found')
        return apiFailure(
          'not_found',
          '문서를 찾을 수 없습니다. 목록을 새로 불러와 주세요.',
          404,
          traceId,
        );
      if (response.status === 413 && code === 'document_too_large')
        return apiFailure(
          'document_too_large',
          '문서가 UTF-8 1 MiB 크기 제한을 초과했습니다.',
          413,
          traceId,
        );
      if (response.status === 409 && code === 'catalog_changed')
        return apiFailure(
          'catalog_changed',
          '목록이 변경되었습니다. 첫 페이지부터 다시 불러와 주세요.',
          409,
          traceId,
        );
      if (response.status === 422 && code === 'invalid_cursor')
        return apiFailure(
          'invalid_cursor',
          '페이지 기준이 현재 조회 범위와 다릅니다. 첫 페이지부터 다시 불러와 주세요.',
          422,
          traceId,
        );
      if (response.status === 503 && code === 'storage_busy')
        return apiFailure(
          'storage_busy',
          '서버가 자료를 처리 중입니다. 잠시 후 다시 시도해 주세요.',
          503,
          traceId,
        );
      if (response.status === 503)
        return apiFailure(
          'access_unavailable',
          '서버의 권한 설정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
          503,
          traceId,
        );
      if (response.status === 409)
        return apiFailure(
          code ?? 'conflict',
          '작업 기준이 변경되었습니다. 현재 상태를 새로 확인해 주세요.',
          409,
          traceId,
        );
      return apiFailure(
        code ?? 'http_error',
        '서버에서 조회 요청을 처리하지 못했습니다.',
        response.status,
        traceId,
      );
    }
    return {
      ok: true,
      value: await decode(response),
    };
  } catch (error: unknown) {
    // 호출자가 직접 취소한 요청은 서버 문제가 아니므로 세지 않습니다.
    if (!controller.signal.aborted) {
      const body = error instanceof Error ? error.message : '';
      if (
        timeout.aborted ||
        !['response_too_large', 'invalid_response', 'source_mismatch'].includes(
          body,
        )
      )
        recordServerFailure();
    }
    if (timeout.aborted)
      return apiFailure(
        'timeout',
        '서버 응답 시간이 초과되었습니다. 다시 시도해 주세요.',
      );
    if (error instanceof Error && error.message === 'response_too_large')
      return apiFailure(
        'response_too_large',
        '서버 응답이 허용 크기를 초과했습니다.',
      );
    if (error instanceof Error && error.message === 'invalid_response')
      return apiFailure(
        'invalid_response',
        '서버가 올바른 JSON 응답을 보내지 않았습니다.',
      );
    if (error instanceof Error && error.message === 'source_mismatch')
      return apiFailure(
        'source_mismatch',
        '원본의 판본·크기·무결성을 확인할 수 없습니다. 목록을 새로 불러와 주세요.',
      );
    return apiFailure(
      'network_error',
      '서버에 연결할 수 없습니다. 주소와 네트워크 상태를 확인해 주세요.',
    );
  }
}

/** 일반 조회는 기존 JSON 한도와 오류 처리를 유지합니다. */
export async function readApiJson(
  url: string,
  token: string | null,
  controller: AbortController,
  options: ReadApiOptions = {},
): Promise<ReadApiResult> {
  return readApi(
    url,
    token,
    controller,
    (response: Response): Promise<unknown> =>
      readApiJsonBody(response, options.maxResponseBytes),
    'application/json',
    options,
  );
}

/** 고정 원본의 실제 바이트·hash·MIME을 확인하며 바이너리는 문자열로 변환하지 않습니다. */
export async function readApiSourceBytes(
  url: string,
  token: string | null,
  controller: AbortController,
  expected: SourcePreviewRequest,
): Promise<ReadApiResult> {
  return readApi(
    url,
    token,
    controller,
    async (response: Response): Promise<Uint8Array> => {
      const encoding = response.headers.get('content-encoding')?.toLowerCase();
      const length = response.headers.get('content-length');
      // fetch는 압축을 해제하므로 압축 응답의 전송 길이를 원본 길이와 비교하지 않습니다.
      const identity = !encoding || encoding === 'identity';
      if (
        !Number.isSafeInteger(expected.sizeBytes) ||
        expected.sizeBytes < 0 ||
        expected.sizeBytes > MAX_SOURCE_BYTES ||
        (identity &&
          length !== null &&
          length !== String(expected.sizeBytes)) ||
        response.headers.get('content-type')?.toLowerCase() !==
          sourceContentType(expected.format) ||
        response.headers.get('x-source-sha256') !== expected.sourceSha256
      ) {
        await response.body?.cancel();
        throw new Error('source_mismatch');
      }
      const bytes = await responseBytes(response, expected.sizeBytes);
      if (
        bytes.byteLength !== expected.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !==
          expected.sourceSha256 ||
        !sourceSignatureMatches(expected.format, bytes)
      )
        throw new Error('source_mismatch');
      return bytes;
    },
    sourceMediaType(expected.format),
  );
}
