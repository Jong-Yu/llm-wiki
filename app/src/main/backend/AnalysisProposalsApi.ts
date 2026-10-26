import { createHash } from 'node:crypto';
import { z } from 'zod';
import { analysisProposalRequestSchema } from '@contracts/analysisProposals.contract';
import type {
  AnalysisProposalRequest,
  AnalysisProposalResult,
  ProposalRecovery,
} from '@contracts/analysisProposals.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import {
  readWorkspaceJsonBody,
  workspaceHttpFailure,
} from './WorkspaceApiService';

const envelope = z.object({
  data: knowledgeValueSchema,
  meta: z.object({ trace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
});
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  policy_revision: z.string(),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
});

/** 요청의 작업 이름으로만 고정 HTTP 경로를 만듭니다. */
export function proposalRoute(request: AnalysisProposalRequest): {
  path: string;
  method: 'GET' | 'POST';
  permission: string | null;
} {
  if (request.operation === 'prepare')
    return {
      path: 'analysis-proposals',
      method: 'POST',
      permission: 'ontology_write',
    };
  const path = `analysis-proposals/${request.input.proposal_id}`;
  switch (request.operation) {
    case 'execution-create':
      return {
        path: `${path}/executions`,
        method: 'POST',
        permission: 'ontology_write',
      };
    case 'execution-read':
      return {
        path: `${path}/executions/${request.input.execution_id}`,
        method: 'GET',
        permission: null,
      };
    case 'execution-cancel':
      return {
        path: `analysis-jobs/${request.input.job_id}/cancel`,
        method: 'POST',
        permission: 'source_write',
      };
    case 'read':
      return { path, method: 'GET', permission: null };
    case 'receipt':
      return {
        path: `${path}/requests/${request.input.request_id}`,
        method: 'GET',
        permission: null,
      };
    case 'validate':
      return { path: `${path}/validation`, method: 'POST', permission: null };
    case 'submit':
      return {
        path: `${path}/submissions`,
        method: 'POST',
        permission: 'ontology_write',
      };
    case 'apply':
      return {
        path: `${path}/apply`,
        method: 'POST',
        permission: 'ontology_write',
      };
    case 'decide':
      return {
        path: `${path}/missing-decisions`,
        method: 'POST',
        permission: 'ontology_review',
      };
    case 'complete':
      return {
        path: `${path}/completions`,
        method: 'POST',
        permission: 'ontology_review',
      };
  }
}

/** 생성 응답이 유실돼도 서버와 같은 고정 ID로 조회할 수 있게 합니다. */
export function proposalRecovery(
  request: AnalysisProposalRequest,
  context: AnalysisContext,
): ProposalRecovery | undefined {
  if (!('request_id' in request.input)) return undefined;
  const proposalId =
    request.operation === 'prepare'
      ? createHash('sha256')
          .update(
            `${context.selection.tenant}:${context.active.userId}:${request.input.request_id}`,
          )
          .digest('hex')
          .slice(0, 32)
      : request.input.proposal_id;
  return {
    proposalId,
    requestId: request.input.request_id,
    operation: request.operation,
  };
}

/** 전송 성공과 실제 저장 증거를 구별하며 쓰기를 자동 재전송하지 않습니다. */
function unknownOutcome(
  recovery: ProposalRecovery | undefined,
): AnalysisProposalResult {
  return {
    ok: false,
    error: {
      code: 'outcome_unknown',
      message:
        '요청 결과가 미확인입니다. 초안과 요청 ID를 보존했습니다. 해당 요청 기록을 조회해 주세요.',
      retry: 'reconcile',
      recovery,
    },
  };
}

/** 인증·범위와 응답 수명을 main에 한정하는 추출안 전용 API입니다. */
export class AnalysisProposalsApi {
  #connection: ConnectionService;
  #requests = new Set<AbortController>();
  constructor(connection: ConnectionService) {
    this.#connection = connection;
    connection.onScopeChanged((): void => {
      for (const controller of this.#requests) controller.abort();
    });
  }

  /** 외부 입력을 다시 검사하고 현재 연결의 권한과 동일한 기준만 사용합니다. */
  async execute(
    value: AnalysisProposalRequest,
  ): Promise<AnalysisProposalResult> {
    const parsed = analysisProposalRequestSchema.safeParse(value);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: '추출안 요청과 기준 판본을 확인해 주세요.',
        },
      };
    const request = parsed.data;
    const route = proposalRoute(request);
    const mutation = route.permission !== null;
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    const expected = request.expectedScope;
    if (
      expected.userId !== context.active.userId ||
      expected.tenant !== context.selection.tenant ||
      expected.profileId !== context.selection.profile ||
      expected.policyRevision !== context.active.policyRevision
    )
      return {
        ok: false,
        error: {
          code: 'scope_changed',
          message:
            '작업 공간·관점이 바뀌었습니다. 이전 초안은 원래 범위에 보존합니다.',
        },
      };
    const workspace = context.active.workspaces.find(
      (item: AnalysisContext['active']['workspaces'][number]): boolean =>
        item.id === context.selection.tenant,
    );
    const profile = workspace?.profiles.find(
      (item: NonNullable<typeof workspace>['profiles'][number]): boolean =>
        item.id === context.selection.profile,
    );
    if (
      !workspace ||
      !profile ||
      (route.permission && !workspace.permissions.includes(route.permission)) ||
      (request.operation === 'execution-create' &&
        !workspace.permissions.includes('source_write')) ||
      (request.operation === 'decide' &&
        request.input.action === 'keep' &&
        !workspace.permissions.includes('ontology_write'))
    )
      return {
        ok: false,
        error: {
          code: 'forbidden',
          message: '현재 범위에서 이 작업을 실행할 권한이 없습니다.',
          status: 403,
        },
      };
    const recovery = proposalRecovery(request, context);
    const url = new URL(
      `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/${route.path}`,
    );
    const input: Record<string, unknown> = { ...request.input };
    delete input.proposal_id;
    delete input.execution_id;
    delete input.job_id;
    const body =
      route.method === 'GET'
        ? undefined
        : JSON.stringify({ ...input, profile: context.selection.profile });
    if (body && Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024)
      return {
        ok: false,
        error: {
          code: 'request_too_large',
          message: '요청이 8 MiB 전송 한도를 초과했습니다.',
        },
      };
    if (route.method === 'GET')
      url.searchParams.set('profile', context.selection.profile);
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      const response = await fetch(url, {
        method: route.method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
        headers: {
          Authorization: `Bearer ${context.token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
      });
      if (!response.ok) {
        let data: unknown = null;
        try {
          data = await readWorkspaceJsonBody(response);
        } catch {
          /* HTTP 상태는 본문 파싱 실패와 분리합니다. */
        }
        if (!this.#connection.isAnalysisCurrent(context))
          return mutation
            ? unknownOutcome(recovery)
            : {
                ok: false,
                error: {
                  code: 'scope_changed',
                  message: '조회 중 범위가 변경되어 결과를 숨겼습니다.',
                },
              };
        const failure = workspaceHttpFailure(response.status, data, mutation);
        this.#connection.invalidateApiScope(
          failure.error.code,
          failure.error.status,
        );
        return {
          ok: false,
          error: { ...failure.error, recovery },
        };
      }
      const result = envelope.parse(await readWorkspaceJsonBody(response));
      const access = accessSchema.parse(result.data.access);
      if (
        !this.#connection.isAnalysisCurrent(context) ||
        access.user_id !== expected.userId ||
        access.tenant !== expected.tenant ||
        access.profile_id !== expected.profileId ||
        access.policy_revision !== expected.policyRevision ||
        access.domain !== profile.domain ||
        access.viewpoint !== profile.viewpoint
      ) {
        this.#connection.invalidateApiScope('scope_changed');
        return mutation
          ? unknownOutcome(recovery)
          : {
              ok: false,
              error: {
                code: 'scope_changed',
                message: '현재 권한 범위와 응답이 달라 결과를 숨겼습니다.',
              },
            };
      }
      return { ok: true, data: result.data, traceId: result.meta.trace_id };
    } catch {
      return mutation
        ? unknownOutcome(recovery)
        : {
            ok: false,
            error: {
              code: 'read_failed',
              message:
                '응답을 확인할 수 없습니다. 이전 초안과 근거는 유지합니다.',
            },
          };
    } finally {
      this.#requests.delete(controller);
    }
  }
}
