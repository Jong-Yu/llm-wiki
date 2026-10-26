import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import type {
  WorkspaceRequest,
  WorkspaceResult,
  WorkspaceScope,
  WorkspaceRecovery,
} from '@contracts/workspace.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import { apiFailure } from './readApi';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: z.string().regex(/^[a-f0-9]{64}$/),
});
const envelopeSchema = z.object({
  data: knowledgeValueSchema,
  meta: z.object({ trace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
});
const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[a-z0-9_]{1,128}$/),
    retry: z.enum(['none', 'read_again', 'same_basis', 'reconcile']).optional(),
    details: z
      .object({ cleanup_failures: z.array(z.unknown()).optional() })
      .optional(),
  }),
  meta: z.object({ trace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
});
type Failure = Extract<WorkspaceResult, { ok: false }>;
type Route = {
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  permission: string | null;
};

/** 업무 이름을 고정 HTTP 입구에만 대응시키고 입력에서 URL/메서드를 만들지 않습니다. */
function route(request: WorkspaceRequest): Route {
  switch (request.operation) {
    case 'createConversion':
      return {
        path: 'analysis-conversions',
        method: 'POST',
        permission: 'source_write',
      };
    case 'conversion':
      return {
        path: `analysis-conversions/${request.input.conversion_id}`,
        method: 'GET',
        permission: null,
      };
    case 'createAnalysisPlan':
      return {
        path: 'analysis-plans',
        method: 'POST',
        permission: 'source_write',
      };
    case 'analysisPlan':
      return {
        path: `analysis-plans/${request.input.plan_id}`,
        method: 'GET',
        permission: null,
      };
    case 'validateAnalysisPlan':
      return {
        path: `analysis-plans/${request.input.plan_id}/validate`,
        method: 'POST',
        permission: null,
      };
    case 'handoffAnalysisPlan':
      return {
        path: `analysis-plans/${request.input.plan_id}/handoffs`,
        method: 'POST',
        permission: 'source_write',
      };
    case 'analysisPlanReceipt':
      return {
        path: `analysis-plans/${request.input.plan_id}/handoffs/${request.input.request_id}`,
        method: 'GET',
        permission: null,
      };
    case 'conversations':
      return { path: `conversations`, method: 'GET', permission: null };
    case 'conversation':
      return {
        path: `conversations/${encodeURIComponent(request.input.record_id)}`,
        method: 'GET',
        permission: null,
      };
    case 'createConversation':
      return {
        path: `conversations`,
        method: 'POST',
        permission: 'conversation_write',
      };
    case 'appendTurn':
      return {
        path: `conversations/${encodeURIComponent(request.input.record_id)}/turns`,
        method: 'POST',
        permission: 'conversation_write',
      };
    case 'savedResults':
      return { path: `saved-results`, method: 'GET', permission: null };
    case 'savedResult':
      return {
        path: `saved-results/${encodeURIComponent(request.input.record_id)}`,
        method: 'GET',
        permission: null,
      };
    case 'createSavedResult':
      return {
        path: `saved-results`,
        method: 'POST',
        permission: 'result_write',
      };
    case 'comparisons':
      return { path: `comparisons`, method: 'GET', permission: null };
    case 'comparison':
      return {
        path: `comparisons/${encodeURIComponent(request.input.record_id)}`,
        method: 'GET',
        permission: null,
      };
    case 'createComparison':
      return {
        path: `comparisons`,
        method: 'POST',
        permission: 'comparison_write',
      };
    case 'completeComparison':
      return {
        path: `comparisons/${encodeURIComponent(request.input.record_id)}/completions`,
        method: 'POST',
        permission: 'comparison_write',
      };
    case 'personalReceipt':
      return {
        path: `personal-requests/${request.input.kind}/${request.input.request_id}`,
        method: 'GET',
        permission: null,
      };
    case 'correspondenceFind':
      return { path: `correspondences/find`, method: 'POST', permission: null };
    case 'correspondenceDraft':
      return {
        path: `correspondences/drafts/prepare`,
        method: 'POST',
        permission: null,
      };
    case 'correspondencePropose':
      return {
        path: `correspondences`,
        method: 'POST',
        permission: 'ontology_write',
      };
    case 'correspondenceQuery':
      return {
        path: `correspondences/${request.input.correspondence_id}/query`,
        method: 'POST',
        permission: null,
      };
    case 'correspondencePrepare':
      return {
        path: `correspondences/${request.input.correspondence_id}/changes/prepare`,
        method: 'POST',
        permission: null,
      };
    case 'correspondenceReview':
      return {
        path: `correspondences/${request.input.correspondence_id}/reviews`,
        method: 'POST',
        permission: 'ontology_review',
      };
    case 'correspondenceReviewUndo':
      return {
        path: `correspondences/${request.input.correspondence_id}/review-undos`,
        method: 'POST',
        permission: 'ontology_review',
      };
    case 'correspondencePolicy':
      return {
        path: `correspondences/${request.input.correspondence_id}/policies`,
        method: 'POST',
        permission: 'ontology_policy',
      };
    case 'correspondencePolicyUndo':
      return {
        path: `correspondences/${request.input.correspondence_id}/policy-undos`,
        method: 'POST',
        permission: 'ontology_policy',
      };
    case 'extraction':
      return {
        path: `extractions/${request.input.extraction_id}`,
        method: 'GET',
        permission: null,
      };
    case 'extractionContent':
      return {
        path: `extractions/${request.input.extraction_id}/content`,
        method: 'GET',
        permission: null,
      };
    case 'artifactReceipt':
      return {
        path: `analysis-jobs/${request.input.job_id}/artifacts/requests/${request.input.request_id}`,
        method: 'GET',
        permission: null,
      };
    case 'search':
      return { path: 'documents/search', method: 'GET', permission: null };
    case 'ontology':
      return { path: 'documents/ontology', method: 'GET', permission: null };
    case 'connections':
      return { path: 'documents/connections', method: 'GET', permission: null };
    case 'context':
      return {
        path: 'knowledge/context/query',
        method: 'POST',
        permission: null,
      };
    case 'conceptFind':
      return { path: 'concepts/find', method: 'POST', permission: null };
    case 'conceptQuery':
      return { path: 'concepts/query', method: 'POST', permission: null };
    case 'impact':
      return {
        path: 'documents/impact/query',
        method: 'POST',
        permission: null,
      };
    case 'reviewQueue':
      return { path: 'review-queue/query', method: 'POST', permission: null };
    case 'history':
      return { path: 'history/query', method: 'POST', permission: null };
    case 'questionContext':
      return {
        path: 'question-context/prepare',
        method: 'POST',
        permission: null,
      };
    case 'saveDocument':
      return { path: 'documents/content', method: 'PUT', permission: 'write' };
    case 'documentVersions':
      return { path: 'documents/versions', method: 'GET', permission: null };
    case 'documentVersion':
      return {
        path: `documents/versions/${encodeURIComponent(request.input.history_id)}`,
        method: 'GET',
        permission: null,
      };
    case 'restoreDocument':
      return {
        path: 'documents/restorations',
        method: 'POST',
        permission: 'write',
      };
    case 'review':
      return {
        path: 'documents/reviews',
        method: 'POST',
        permission: 'ontology_review',
      };
    case 'reviewUndo':
      return {
        path: 'documents/review-undos',
        method: 'POST',
        permission: 'ontology_review',
      };
    case 'policy':
      return {
        path: 'documents/policies',
        method: 'POST',
        permission: 'ontology_policy',
      };
    case 'policyUndo':
      return {
        path: 'documents/policy-undos',
        method: 'POST',
        permission: 'ontology_policy',
      };
    case 'events':
      return { path: 'documents/events', method: 'GET', permission: null };
    case 'event':
      return {
        path: `documents/events/${encodeURIComponent(request.input.event_id)}`,
        method: 'GET',
        permission: null,
      };
  }
}

/** 변경 결과를 확정할 수 없으면 현재 자료의 대조를 요구하고 자동 재전송하지 않습니다. */
function unknownOutcome(
  traceId?: string,
  recovery?: WorkspaceRecovery,
): Failure {
  return {
    ok: false,
    error: {
      code: 'outcome_unknown',
      message:
        '저장 결과를 확인하지 못했습니다. 현재 본문과 이력을 다시 읽어 변경 내용을 대조해 주세요.',
      retry: 'reconcile',
      ...(traceId ? { traceId } : {}),
      ...(recovery ? { recovery } : {}),
    },
  };
}

/** 외부 실패 본문을 반사하지 않고 상태·안전한 코드·재조회 기준만 전달합니다. */
export function workspaceHttpFailure(
  status: number,
  value: unknown,
  mutation: boolean,
  recovery?: WorkspaceRecovery,
): Failure {
  const metadata = errorEnvelopeSchema.safeParse(value);
  const code = metadata.success ? metadata.data.error.code : 'http_error';
  const traceId = metadata.success ? metadata.data.meta.trace_id : undefined;
  const retry = metadata.success ? metadata.data.error.retry : undefined;
  const cleanupWarningCount = metadata.success
    ? metadata.data.error.details?.cleanup_failures?.length
    : undefined;
  let failure: Failure;
  if (status === 409)
    failure = {
      ok: false,
      error: {
        code: 'conflict',
        message:
          '기준 판본이나 목록이 변경되었습니다. 최신 자료를 읽고 변경 사항을 대조해 주세요.',
        status,
        retry: 'reconcile',
        ...(traceId ? { traceId } : {}),
      },
    };
  else if (status === 503 && code === 'storage_busy')
    failure = {
      ok: false,
      error: {
        code: 'storage_busy',
        message:
          '서버가 자료를 처리 중입니다. 같은 기준 판본으로 나중에 다시 시도해 주세요.',
        status,
        retry: 'same_basis',
        ...(traceId ? { traceId } : {}),
      },
    };
  else if (mutation && status >= 500)
    failure = unknownOutcome(traceId, recovery);
  else {
    const message =
      status === 401
        ? '개인 토큰이 올바르지 않거나 만료되었습니다.'
        : status === 403
          ? '이 작업을 실행할 권한이 없습니다.'
          : status === 404
            ? '요청한 자료나 이력을 찾을 수 없습니다.'
            : status === 413
              ? '요청 또는 자료가 허용 크기를 초과했습니다.'
              : status === 422
                ? '입력한 항목과 기준 판본을 확인해 주세요.'
                : '서버에서 요청을 처리하지 못했습니다.';
    failure = apiFailure(
      status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : code,
      message,
      status,
      traceId,
    );
  }
  return {
    ok: false,
    error: {
      ...failure.error,
      ...(!failure.error.retry && retry ? { retry } : {}),
      ...(cleanupWarningCount ? { cleanupWarningCount } : {}),
    },
  };
}

/** 실제 수신 바이트를 제한하고 UTF-8 JSON만 해석하며 나머지 스트림을 닫습니다. */
export async function readWorkspaceJsonBody(
  response: Response,
): Promise<unknown> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
  ) {
    await response.body?.cancel();
    throw new Error('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
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
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** 예상 범위는 권한 선언이 아니라 오래된 폼을 현재 작업 공간에 쓰지 않게 하는 비교값입니다. */
function matchesExpected(
  expected: WorkspaceScope,
  context: AnalysisContext,
): boolean {
  return (
    expected.userId === context.active.userId &&
    expected.tenant === context.selection.tenant &&
    expected.profileId === context.selection.profile &&
    expected.policyRevision === context.active.policyRevision
  );
}

/** 서버와 같은 고정 ID로만 미확정 계획/변환/인계를 읽고 POST를 반복하지 않습니다. */
function planningRecovery(
  request: WorkspaceRequest,
  context: AnalysisContext,
): WorkspaceRecovery | undefined {
  if (request.operation === 'handoffAnalysisPlan')
    return {
      operation: 'analysisPlanReceipt',
      input: {
        plan_id: request.input.plan_id,
        request_id: request.input.request_id,
      },
    };
  if (
    request.operation !== 'createConversion' &&
    request.operation !== 'createAnalysisPlan'
  )
    return undefined;
  const kind =
    request.operation === 'createConversion' ? 'conversions' : 'plans';
  const fixedId = createHash('sha256')
    .update(
      [
        kind,
        context.selection.tenant,
        context.active.userId,
        request.input.request_id,
      ].join(':'),
    )
    .digest('hex')
    .slice(0, 32);
  return request.operation === 'createConversion'
    ? { operation: 'conversion', input: { conversion_id: fixedId } }
    : { operation: 'analysisPlan', input: { plan_id: fixedId } };
}

/** 허용 업무별 HTTP 요청을 main 인증/선택 수명에 묶고 쓰기를 한 번만 실행합니다. */
export class WorkspaceApiService {
  #connection: ConnectionService;
  #requests = new Set<AbortController>();
  constructor(connection: ConnectionService) {
    this.#connection = connection;
    connection.onScopeChanged((): void => {
      for (const controller of this.#requests) controller.abort();
    });
  }

  /** 입력을 외부 경계에서 검증한 뒤 여기서는 현재 권한과 고정 URL만 사용합니다. */
  async execute(request: WorkspaceRequest): Promise<WorkspaceResult> {
    const selectedRoute = route(request);
    const mutation = selectedRoute.permission !== null;
    if (mutation && !request.expectedScope)
      return apiFailure(
        'invalid_request',
        '저장할 자료의 현재 사용자·작업 공간·관점 기준을 함께 확인해 주세요.',
      );
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    const recovery = planningRecovery(request, context);
    if (
      request.expectedScope &&
      !matchesExpected(request.expectedScope, context)
    )
      return apiFailure(
        'scope_changed',
        '조회하거나 편집하던 작업 공간·관점이 변경되었습니다. 이전 초안을 보존하고 현재 자료를 다시 확인해 주세요.',
      );
    const workspace = context.active.workspaces.find(
      (item: AnalysisContext['active']['workspaces'][number]): boolean =>
        item.id === context.selection.tenant,
    );
    const profile = workspace?.profiles.find(
      (item: NonNullable<typeof workspace>['profiles'][number]): boolean =>
        item.id === context.selection.profile,
    );
    if (!workspace || !profile)
      return apiFailure(
        'scope_changed',
        '현재 작업 공간과 관점을 다시 확인해 주세요.',
      );
    if (
      selectedRoute.permission &&
      !workspace.permissions.includes(selectedRoute.permission)
    )
      return apiFailure('forbidden', '이 작업을 실행할 권한이 없습니다.', 403);
    const url = new URL(
      `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/${selectedRoute.path}`,
    );
    let body: string | undefined;
    if (selectedRoute.method === 'GET') {
      for (const [key, value] of Object.entries(request.input)) {
        if (
          key !== 'event_id' &&
          key !== 'history_id' &&
          !(key === 'record_id' && request.operation !== 'personalReceipt') &&
          ![
            'kind',
            'request_id',
            'extraction_id',
            'plan_id',
            'conversion_id',
          ].includes(key) &&
          !(key === 'job_id' && request.operation === 'artifactReceipt') &&
          (typeof value === 'string' || typeof value === 'number')
        )
          url.searchParams.set(key, String(value));
      }
      url.searchParams.set('profile', context.selection.profile);
    } else {
      const input: Record<string, unknown> = { ...request.input };
      // 경로 식별자는 본문 스키마에 넣지 않으며 제안의 ID만 실제 본문 항목입니다.
      delete input.record_id;
      if (
        request.operation === 'validateAnalysisPlan' ||
        request.operation === 'handoffAnalysisPlan'
      )
        delete input.plan_id;
      if (request.operation !== 'correspondencePropose')
        delete input.correspondence_id;
      if (
        'context_request' in input &&
        typeof input.context_request === 'object' &&
        input.context_request !== null
      )
        input.context_request = {
          ...input.context_request,
          profile: context.selection.profile,
        };
      body = JSON.stringify({ ...input, profile: context.selection.profile });
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)
        return apiFailure(
          'request_too_large',
          '요청이 JSON 전송 크기 제한을 초과했습니다.',
        );
    }
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(15_000);
    this.#requests.add(controller);
    try {
      const response = await fetch(url.href, {
        method: selectedRoute.method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, timeout]),
        headers: {
          Authorization: `Bearer ${context.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      if (response.status < 200 || response.status >= 300) {
        let value: unknown = null;
        try {
          value = await readWorkspaceJsonBody(response);
        } catch {
          /* 오류 본문을 읽지 못해도 HTTP 권한 거부는 유지합니다. */
        }
        if (!this.#connection.isAnalysisCurrent(context))
          return mutation
            ? unknownOutcome(undefined, recovery)
            : apiFailure(
                'scope_changed',
                '조회 중 연결 범위가 변경되어 이전 결과를 숨겼습니다.',
              );
        const failure = workspaceHttpFailure(
          response.status,
          value,
          mutation,
          recovery,
        );
        this.#connection.invalidateApiScope(
          failure.error.code,
          failure.error.status,
        );
        return failure;
      }
      const value = await readWorkspaceJsonBody(response);
      if (!this.#connection.isAnalysisCurrent(context))
        return mutation
          ? unknownOutcome(undefined, recovery)
          : apiFailure(
              'scope_changed',
              '조회 중 연결 범위가 변경되어 이전 결과를 숨겼습니다.',
            );
      const parsed = envelopeSchema.parse(value);
      const access = accessSchema.parse(parsed.data.access);
      if (
        access.user_id !== context.active.userId ||
        access.tenant !== context.selection.tenant ||
        access.profile_id !== context.selection.profile ||
        access.domain !== profile.domain ||
        access.viewpoint !== profile.viewpoint ||
        access.policy_revision !== context.active.policyRevision
      ) {
        this.#connection.invalidateApiScope('scope_changed');
        return mutation
          ? unknownOutcome(parsed.meta.trace_id, recovery)
          : apiFailure(
              'scope_changed',
              '서버의 현재 사용자·작업 공간·관점이 변경되어 결과를 숨겼습니다.',
            );
      }
      return {
        ok: true,
        data: {
          connectionId: context.active.connectionId,
          operation: request.operation,
          data: parsed.data,
          access: {
            userId: access.user_id,
            tenant: access.tenant,
            profileId: access.profile_id,
            domain: access.domain,
            viewpoint: access.viewpoint,
            policyRevision: access.policy_revision,
          },
          traceId: parsed.meta.trace_id,
        },
      };
    } catch (error: unknown) {
      if (mutation) return unknownOutcome(undefined, recovery);
      if (!this.#connection.isAnalysisCurrent(context))
        return apiFailure(
          'scope_changed',
          '조회 중 연결 범위가 변경되어 이전 결과를 숨겼습니다.',
        );
      if (timeout.aborted)
        return apiFailure(
          'timeout',
          '서버 응답 시간이 초과되었습니다. 다시 조회해 주세요.',
        );
      if (error instanceof Error && error.message === 'response_too_large')
        return apiFailure(
          'response_too_large',
          '서버 응답이 허용 크기를 초과했습니다. 조회 범위를 줄여 주세요.',
        );
      return apiFailure(
        'read_failed',
        '서버 응답을 확인할 수 없습니다. 현재 연결과 조회 범위를 확인해 주세요.',
      );
    } finally {
      this.#requests.delete(controller);
    }
  }
}
