import { z } from 'zod';
import { apiFailure, readApiJsonBody } from './readApi';
import type { ApiFailure, ReadApiResult } from './readApi';

const metadataSchema = z.object({
  error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,128}$/) }),
  meta: z.object({ trace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
});

/** 저장 완료를 확인할 수 없는 요청은 재등록 대신 같은 영수증을 조회하게 합니다. */
export function registrationUnknown(traceId?: string): ApiFailure {
  return apiFailure(
    'outcome_unknown',
    '등록 결과를 확인하지 못했습니다. 다시 등록하지 말고 등록 상태를 확인해 주세요.',
    undefined,
    traceId,
  );
}

/** main이 정한 주소로 한 번만 전송하며 전송 오류/5xx는 성공 여부 미확인으로 보존합니다. */
export async function writeSourceApi(
  url: string,
  token: string,
  body: FormData | string,
  controller: AbortController,
): Promise<ReadApiResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(typeof body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      body,
    });
    const value = await readApiJsonBody(response);
    if (
      response.status === 200 ||
      response.status === 201 ||
      response.status === 202
    )
      return { ok: true, value };
    const parsed = metadataSchema.safeParse(value);
    const traceId = parsed.success ? parsed.data.meta.trace_id : undefined;
    if (response.status >= 500) return registrationUnknown(traceId);
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
        '이 작업 공간에 원본을 등록할 권한이 없습니다.',
        403,
        traceId,
      );
    if (
      response.status === 409 &&
      parsed.success &&
      parsed.data.error.code === 'conflict'
    )
      return apiFailure(
        'conflict',
        '다른 원본 판본이 먼저 등록됐습니다. 판본 목록을 새로 조회한 뒤 변경 내용을 다시 확인해 주세요.',
        409,
        traceId,
      );
    if (response.status === 409)
      return apiFailure(
        'request_conflict',
        '같은 등록 요청의 내용이 다릅니다. 기존 등록 상태를 확인해 주세요.',
        409,
        traceId,
      );
    if (response.status === 413)
      return apiFailure(
        'source_limit',
        '원본 크기 또는 서버 보관 한도를 초과했습니다.',
        413,
        traceId,
      );
    if (response.status === 415)
      return apiFailure(
        'unsupported_source',
        '지원되는 문서·이미지 형식과 실제 파일 내용이 일치하는지 확인해 주세요.',
        415,
        traceId,
      );
    if (response.status === 422)
      return apiFailure(
        'invalid_source',
        '원본 제목·형식·UTF-8 내용을 확인해 주세요.',
        422,
        traceId,
      );
    return apiFailure(
      'registration_rejected',
      '서버에서 원본 등록을 거부했습니다.',
      response.status,
      traceId,
    );
  } catch {
    return registrationUnknown();
  }
}
