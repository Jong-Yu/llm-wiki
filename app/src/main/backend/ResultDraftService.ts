import { createHash } from 'node:crypto';
import type { RecoveryService } from './RecoveryService';
import { z } from 'zod';
import type { ConnectionService } from './ConnectionService';
import {
  readWorkspaceJsonBody,
  workspaceHttpFailure,
} from './WorkspaceApiService';
import { resultDraftRequestSchema } from '@contracts/resultDrafts.contract';
import type {
  ResultDraftRequest,
  ResultDraftResult,
} from '@contracts/resultDrafts.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';

type Route = {
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  permissions: string[];
};
const envelope = z.object({
  data: knowledgeValueSchema,
  meta: z.object({ trace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
});
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: z.string(),
});
/** 한정된 결과 초안 업무를 고정 URL과 서버 권한으로 대응시킵니다. */
export function resultDraftRoute(request: ResultDraftRequest): Route {
  switch (request.operation) {
    case 'list':
      return { path: 'result-drafts', method: 'GET', permissions: [] };
    case 'read':
      return {
        path: `result-drafts/${request.input.draft_id}`,
        method: 'GET',
        permissions: [],
      };
    case 'create':
      return {
        path: 'result-drafts',
        method: 'POST',
        permissions: ['result_write'],
      };
    case 'edit':
      return {
        path: `result-drafts/${request.input.draft_id}`,
        method: 'PUT',
        permissions: ['result_write'],
      };
    case 'apply':
      return {
        path: `result-drafts/${request.input.draft_id}/applications`,
        method: 'POST',
        permissions: ['result_write', 'write'],
      };
    case 'receipt':
      return {
        path: `personal-requests/result-drafts/${request.input.request_id}`,
        method: 'GET',
        permissions: [],
      };
    case 'applicationReceipt':
      return {
        path: `result-drafts/${request.input.draft_id}/applications/${request.input.request_id}`,
        method: 'GET',
        permissions: [],
      };
  }
}
/** 외부 오류 본문을 반사하지 않고 안전한 상태만 돌려줍니다. */
function failure(code: string, message: string): ResultDraftResult {
  return { ok: false, error: { code, message } };
}
/** 같은 요청의 확정 저장/거절 증거만 journal을 해제합니다. */
function confirmedReceipt(request: ResultDraftRequest, data: unknown): boolean {
  if (!('request_id' in request.input)) return false;
  const requestId = request.input.request_id;
  if (
    request.operation === 'apply' ||
    request.operation === 'applicationReceipt'
  ) {
    const parsed = z
      .object({
        request_id: z.string(),
        record_id: z.string(),
        saved: z.boolean().nullable(),
        receipt: z
          .object({
            draft_id: z.string(),
            draft_revision: z.string(),
            document: z.string(),
          })
          .nullable(),
      })
      .safeParse(data);
    if (
      !parsed.success ||
      parsed.data.request_id !== requestId ||
      parsed.data.record_id !== request.input.draft_id ||
      parsed.data.saved === null
    )
      return false;
    return (
      !parsed.data.saved ||
      (!!parsed.data.receipt &&
        parsed.data.receipt.draft_id === request.input.draft_id &&
        (request.operation !== 'apply' ||
          (parsed.data.receipt.draft_revision ===
            request.input.expected_revision &&
            parsed.data.receipt.document === request.input.document)))
    );
  }
  const parsed = z
    .object({
      record: z.object({
        id: z.string(),
        user_id: z.string(),
        tenant: z.string(),
        requests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
      }),
    })
    .safeParse(data);
  return (
    parsed.success &&
    parsed.data.record.user_id === request.expectedScope.userId &&
    parsed.data.record.tenant === request.expectedScope.tenant &&
    !!parsed.data.record.requests[requestId] &&
    (!('draft_id' in request.input) ||
      parsed.data.record.id === request.input.draft_id)
  );
}
/** 연결 수명과 현재 주체를 유지하며 초안 저장은 한 번만 전송합니다. */
export class ResultDraftService {
  #connection: ConnectionService;
  #requests = new Set<AbortController>();
  readonly recovery: RecoveryService | undefined;
  constructor(connection: ConnectionService, recovery?: RecoveryService) {
    this.recovery = recovery;
    this.#connection = connection;
    connection.onScopeChanged((): void => {
      for (const request of this.#requests) request.abort();
    });
  }
  /** CAS·관측·요청 ID를 그대로 보내고 재시도는 영수증 조회로 분리합니다. */
  async execute(value: ResultDraftRequest): Promise<ResultDraftResult> {
    const parsed = resultDraftRequestSchema.safeParse(value);
    if (!parsed.success)
      return failure('invalid_request', '초안 요청 항목을 확인해 주세요.');
    const request = parsed.data;
    const route = resultDraftRoute(request);
    const mutation = route.method !== 'GET';
    const unknown = (): ResultDraftResult =>
      failure(
        'outcome_unknown',
        '저장 응답을 확인하지 못했습니다. 동일 요청의 영수증을 조회해 주세요.',
      );
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
      return failure(
        'scope_changed',
        '편집 당시 사용자·작업 공간·관점을 다시 확인해 주세요.',
      );
    const workspace = context.active.workspaces.find(
      (item: (typeof context.active.workspaces)[number]): boolean =>
        item.id === context.selection.tenant,
    );
    const profile = workspace?.profiles.find(
      (item: NonNullable<typeof workspace>['profiles'][number]): boolean =>
        item.id === context.selection.profile,
    );
    if (!workspace || !profile)
      return failure('scope_changed', '현재 작업 공간을 다시 선택해 주세요.');
    if (
      route.permissions.some(
        (permission: string): boolean =>
          !workspace.permissions.includes(permission),
      )
    )
      return failure('forbidden', '이 작업에 필요한 현재 권한이 없습니다.');
    const url = new URL(
      `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/${route.path}`,
    );
    const input: Record<string, unknown> = { ...request.input };
    delete input.draft_id;
    let body: string | undefined;
    if (!mutation) {
      delete input.request_id;
      for (const [key, entry] of Object.entries(input)) {
        if (typeof entry === 'string' || typeof entry === 'number')
          url.searchParams.set(key, String(entry));
      }
      url.searchParams.set('profile', context.selection.profile);
    } else {
      body = JSON.stringify({ ...input, profile: context.selection.profile });
      if (Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024)
        return failure(
          'request_too_large',
          '초안 요청이 전송 한도를 초과했습니다.',
        );
    }
    if (mutation && 'request_id' in request.input && this.recovery) {
      const payload = JSON.stringify({
        operation: request.operation,
        input: request.input,
        requestHash: createHash('sha256')
          .update(body || '')
          .digest('hex'),
      });
      const journal = await this.recovery.capture(
        context,
        'pending-result-draft',
        request.input.request_id,
        payload,
        null,
      );
      if (!journal.ok) return journal;
    }
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      const response = await fetch(url, {
        method: route.method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
        headers: {
          Authorization: `Bearer ${context.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      if (!response.ok) {
        let error: unknown = null;
        try {
          error = await readWorkspaceJsonBody(response);
        } catch {
          /* 권한 거부는 오류 본문 손상과 무관합니다. */
        }
        if (!this.#connection.isAnalysisCurrent(context))
          return mutation
            ? unknown()
            : failure('scope_changed', '조회 중 연결 범위가 변경되었습니다.');
        const result = workspaceHttpFailure(response.status, error, mutation);
        this.#connection.invalidateApiScope(
          result.error.code,
          result.error.status,
        );
        return result;
      }
      const result = envelope.parse(await readWorkspaceJsonBody(response));
      if (!this.#connection.isAnalysisCurrent(context))
        return mutation
          ? unknown()
          : failure('scope_changed', '조회 중 연결 범위가 변경되었습니다.');
      const access = accessSchema.parse(result.data.access);
      if (
        access.user_id !== expected.userId ||
        access.tenant !== expected.tenant ||
        access.profile_id !== expected.profileId ||
        access.policy_revision !== expected.policyRevision ||
        access.domain !== profile.domain ||
        access.viewpoint !== profile.viewpoint
      ) {
        this.#connection.invalidateApiScope('scope_changed');
        return mutation
          ? unknown()
          : failure(
              'scope_changed',
              '현재 허용 범위와 응답이 달라 자료를 숨겼습니다.',
            );
      }
      if (
        'request_id' in request.input &&
        this.recovery &&
        confirmedReceipt(request, result.data)
      ) {
        const receiptRequestId = request.input.request_id;
        const journal = await this.recovery.readContext(
          context,
          'pending-result-draft',
        );
        if (journal.ok) {
          const entry = journal.data.entries.find(
            (item: (typeof journal.data.entries)[number]): boolean =>
              item.key === receiptRequestId,
          );
          if (entry)
            await this.recovery.removeContext(
              context,
              entry.kind,
              entry.key,
              entry.revision,
            );
        }
      }
      return {
        ok: true,
        data: {
          connectionId: context.active.connectionId,
          operation: request.operation,
          data: result.data,
          access: expected,
          traceId: result.meta.trace_id,
        },
      };
    } catch {
      return mutation
        ? unknown()
        : failure(
            'unavailable',
            '초안 자료를 읽지 못했습니다. 연결을 확인해 주세요.',
          );
    } finally {
      this.#requests.delete(controller);
    }
  }
}
