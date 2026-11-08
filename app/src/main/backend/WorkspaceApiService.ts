import { sameAccessRevision } from '@contracts/connection.contract';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import type {
  WorkspaceRequest,
  WorkspaceResult,
  WorkspaceRecovery,
} from '@contracts/workspace.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import {
  ontologySearchPageSchema,
  ontologyNeighborPageSchema,
  ontologyGlossaryCardSchema,
} from '@contracts/ontologyExploration.contract';
import { apiFailure, readApiJsonBody, matchesExpectedScope } from './readApi';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: z.string().regex(/^[a-f0-9]{64}$/),
  access_revision: z
    .string()
    .min(1)
    .nullish()
    .transform(
      (value: string | null | undefined): string | undefined =>
        value ?? undefined,
    ),
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
type Operation = WorkspaceRequest['operation'];
type Inputs = {
  [O in Operation]: Extract<WorkspaceRequest, { operation: O }>['input'];
};
type Resource<O extends Operation> =
  | string
  | readonly [
      base: string,
      id: Extract<keyof Inputs[O], string>,
      suffix?: string,
      secondId?: Extract<keyof Inputs[O], string>,
    ];
type RouteSpec<O extends Operation> =
  | readonly [
      'GET',
      Resource<O>,
      query?: readonly Extract<keyof Inputs[O], string>[],
    ]
  | readonly [
      'POST' | 'PUT',
      Resource<O>,
      permission?: string | ((input: Inputs[O]) => string),
      omit?: readonly Extract<keyof Inputs[O], string>[],
    ];
type Route = {
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  permission: string | null;
  query?: readonly string[];
  omit?: readonly string[];
};

/** 독립 관계 추가/되돌림에서만 판단 종류에 맞는 기존 권한을 선택합니다. */
function relationPermission(input: { kind: 'source' | 'policy' }): string {
  return input.kind === 'policy' ? 'ontology_policy' : 'ontology_review';
}

// GET의 세 번째 항목은 query 허용 키, POST/PUT의 네 번째 항목은 본문에서 뺄 경로 키입니다.
// 경로 배열은 고정 prefix/식별자/suffix/두 번째 식별자 순서이며 키는 operation 입력으로 검사합니다.
const routes: { [O in Operation]: RouteSpec<O> } = {
  relationCreate: ['POST', 'documents/relations', relationPermission],
  relationUndo: ['POST', 'documents/relation-undos', relationPermission],
  relationRequest: [
    'GET',
    ['documents/relation-requests', 'request_id'],
    ['document'],
  ],
  cleanupPreview: [
    'GET',
    'documents/cleanup-preview',
    ['document', 'limit', 'cursor'],
  ],
  cleanupHistory: [
    'GET',
    'documents/cleanup-events',
    ['document', 'limit', 'cursor'],
  ],
  cleanupRequest: [
    'GET',
    ['documents/cleanup-requests', 'request_id'],
    ['document'],
  ],
  cleanupApply: ['POST', 'documents/cleanup', 'ontology_review'],
  cleanupUndo: ['POST', 'documents/cleanup-undos', 'ontology_review'],
  createConversion: ['POST', 'analysis-conversions', 'source_write'],
  conversion: ['GET', ['analysis-conversions', 'conversion_id']],
  createAnalysisPlan: ['POST', 'analysis-plans', 'source_write'],
  analysisPlan: ['GET', ['analysis-plans', 'plan_id']],
  validateAnalysisPlan: [
    'POST',
    ['analysis-plans', 'plan_id', 'validate'],
    undefined,
    ['plan_id'],
  ],
  handoffAnalysisPlan: [
    'POST',
    ['analysis-plans', 'plan_id', 'handoffs'],
    'source_write',
    ['plan_id'],
  ],
  analysisPlanReceipt: [
    'GET',
    ['analysis-plans', 'plan_id', 'handoffs', 'request_id'],
  ],
  conversations: ['GET', 'conversations', ['limit', 'cursor']],
  conversation: ['GET', ['conversations', 'record_id']],
  createConversation: ['POST', 'conversations', 'conversation_write'],
  appendTurn: [
    'POST',
    ['conversations', 'record_id', 'turns'],
    'conversation_write',
    ['record_id'],
  ],
  savedResults: ['GET', 'saved-results', ['limit', 'cursor']],
  savedResult: ['GET', ['saved-results', 'record_id']],
  createSavedResult: ['POST', 'saved-results', 'result_write'],
  comparisons: ['GET', 'comparisons', ['limit', 'cursor']],
  comparison: ['GET', ['comparisons', 'record_id']],
  createComparison: ['POST', 'comparisons', 'comparison_write'],
  completeComparison: [
    'POST',
    ['comparisons', 'record_id', 'completions'],
    'comparison_write',
    ['record_id'],
  ],
  personalReceipt: [
    'GET',
    ['personal-requests', 'kind', undefined, 'request_id'],
    ['record_id'],
  ],
  correspondenceFind: ['POST', 'correspondences/find'],
  correspondenceDraft: ['POST', 'correspondences/drafts/prepare'],
  correspondencePropose: ['POST', 'correspondences', 'ontology_write'],
  correspondenceQuery: [
    'POST',
    ['correspondences', 'correspondence_id', 'query'],
    undefined,
    ['correspondence_id'],
  ],
  correspondencePrepare: [
    'POST',
    ['correspondences', 'correspondence_id', 'changes/prepare'],
    undefined,
    ['correspondence_id'],
  ],
  correspondenceReview: [
    'POST',
    ['correspondences', 'correspondence_id', 'reviews'],
    'ontology_review',
    ['correspondence_id'],
  ],
  correspondenceReviewUndo: [
    'POST',
    ['correspondences', 'correspondence_id', 'review-undos'],
    'ontology_review',
    ['correspondence_id'],
  ],
  correspondencePolicy: [
    'POST',
    ['correspondences', 'correspondence_id', 'policies'],
    'ontology_policy',
    ['correspondence_id'],
  ],
  correspondencePolicyUndo: [
    'POST',
    ['correspondences', 'correspondence_id', 'policy-undos'],
    'ontology_policy',
    ['correspondence_id'],
  ],
  extraction: ['GET', ['extractions', 'extraction_id'], ['job_id']],
  extractionContent: [
    'GET',
    ['extractions', 'extraction_id', 'content'],
    ['job_id', 'extraction_revision', 'offset', 'limit'],
  ],
  artifactReceipt: [
    'GET',
    ['analysis-jobs', 'job_id', 'artifacts/requests', 'request_id'],
  ],
  search: ['GET', 'documents/search', ['query', 'limit']],
  ontology: ['GET', 'documents/ontology', ['document']],
  connections: ['GET', 'documents/connections', ['document', 'limit']],
  context: ['POST', 'knowledge/context/query'],
  conceptFind: ['POST', 'concepts/find'],
  conceptQuery: ['POST', 'concepts/query'],
  ontologySearch: ['POST', 'ontology/search'],
  ontologyNeighbors: ['POST', 'ontology/neighbors'],
  ontologyGlossary: ['POST', 'ontology/glossary'],
  impact: ['POST', 'documents/impact/query'],
  reviewQueue: ['POST', 'review-queue/query'],
  history: ['POST', 'history/query'],
  questionContext: ['POST', 'question-context/prepare'],
  saveDocument: ['PUT', 'documents/content', 'write'],
  documentVersions: [
    'GET',
    'documents/versions',
    ['document', 'limit', 'cursor'],
  ],
  documentVersion: ['GET', ['documents/versions', 'history_id'], ['document']],
  restoreDocument: ['POST', 'documents/restorations', 'write'],
  review: ['POST', 'documents/reviews', 'ontology_review'],
  reviewUndo: ['POST', 'documents/review-undos', 'ontology_review'],
  policy: ['POST', 'documents/policies', 'ontology_policy'],
  policyUndo: ['POST', 'documents/policy-undos', 'ontology_policy'],
  events: ['GET', 'documents/events', ['document', 'limit', 'cursor']],
  event: ['GET', ['documents/events', 'event_id'], ['document']],
};

/** 검증된 operation의 선언만 읽으며 사용자 입력으로 HTTP 메서드나 권한을 정하지 않습니다. */
function route<O extends Operation>(request: {
  operation: O;
  input: Inputs[O];
}): Route {
  const spec = routes[request.operation];
  const input: Record<string, unknown> = request.input;
  const resource = spec[1];
  let path: string;
  if (typeof resource === 'string') path = resource;
  else {
    const [base, id, suffix, secondId] = resource;
    path = `${base}/${encodeURIComponent(String(input[id]))}${suffix ? `/${suffix}` : ''}${secondId ? `/${encodeURIComponent(String(input[secondId]))}` : ''}`;
  }
  if (spec[0] === 'GET')
    return { path, method: 'GET', permission: null, query: spec[2] };
  const permission = spec[2];
  return {
    path,
    method: spec[0],
    permission:
      typeof permission === 'function'
        ? permission(request.input)
        : (permission ?? null),
    omit: spec[3],
  };
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
        code: code === 'catalog_changed' ? code : 'conflict',
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
  return readApiJsonBody(response, MAX_RESPONSE_BYTES);
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
        '저장할 자료의 현재 사용자와 작업 공간을 함께 확인해 주세요.',
      );
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    const recovery = planningRecovery(request, context);
    if (
      request.expectedScope &&
      !matchesExpectedScope(request.expectedScope, context)
    )
      return apiFailure(
        'scope_changed',
        '조회하거나 편집하던 작업 공간 또는 조회 설정이 변경되었습니다. 이전 초안을 보존하고 현재 자료를 다시 확인해 주세요.',
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
        '현재 작업 공간을 다시 확인해 주세요.',
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
          selectedRoute.query?.includes(key) &&
          (typeof value === 'string' || typeof value === 'number')
        )
          url.searchParams.set(key, String(value));
      }
      url.searchParams.set('profile', context.selection.profile);
    } else {
      const input: Record<string, unknown> = { ...request.input };
      for (const key of selectedRoute.omit ?? []) delete input[key];
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
      // 지도 페이지는 전체 지식 JSON으로 위장하지 않고 별도 경량 계약까지 검사합니다.
      if (request.operation === 'ontologySearch')
        ontologySearchPageSchema.parse(parsed.data);
      if (request.operation === 'ontologyNeighbors')
        ontologyNeighborPageSchema.parse(parsed.data);
      if (request.operation === 'ontologyGlossary') {
        const card = ontologyGlossaryCardSchema.parse(parsed.data);
        if (
          card.document.document !== request.input.document ||
          card.entity.id !== request.input.entity_id ||
          card.document.state_revision !==
            request.input.expected_state_revision ||
          (card.source_passage !== null &&
            card.source_passage.source_revision !==
              card.document.source_revision)
        )
          return apiFailure(
            'response_invalid',
            '선택한 개념과 용어 설명의 판본이 다릅니다. 다시 불러와 주세요.',
          );
      }
      if (
        access.user_id !== context.active.userId ||
        access.tenant !== context.selection.tenant ||
        access.profile_id !== context.selection.profile ||
        access.domain !== profile.domain ||
        access.viewpoint !== profile.viewpoint ||
        !sameAccessRevision(
          {
            policyRevision: access.policy_revision,
            accessRevision: access.access_revision,
          },
          context.active,
        )
      ) {
        this.#connection.invalidateApiScope('scope_changed');
        return mutation
          ? unknownOutcome(parsed.meta.trace_id, recovery)
          : apiFailure(
              'scope_changed',
              '서버의 현재 사용자 또는 작업 공간의 조회 설정이 변경되어 결과를 숨겼습니다.',
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
            ...(access.access_revision
              ? { accessRevision: access.access_revision }
              : {}),
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
