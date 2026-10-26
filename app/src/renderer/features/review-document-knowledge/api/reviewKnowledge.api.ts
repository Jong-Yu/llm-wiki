import { z } from 'zod';
import type { ConnectionResult } from '@contracts/connection.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type {
  WorkspaceOperation,
  WorkspaceRequest,
} from '@contracts/workspace.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { documentsGateway } from '@renderer/platform/documents';
import { workspaceGateway } from '@renderer/platform/workspace';
import type {
  ReviewContext,
  ReviewError,
  ReviewEventPage,
  ReviewEventDetail,
  ReviewMutation,
  ReviewOutcome,
  ReviewScope,
  ReviewSelection,
} from '../model/review.types';

const token = z.string().regex(/^[a-f0-9]{64}$/);
const eventId = z.string().regex(/^[a-f0-9]{32}$/);
const pageSchema = z.object({
  document: z.string(),
  items: z.array(knowledgeValueSchema),
  state_revision: token,
  pending_history: z.array(z.string()),
  next_cursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.json()),
  requires_refresh: z.boolean(),
});
const detailSchema = z.object({
  document: z.string(),
  event: knowledgeValueSchema,
  state_revision: token,
  pending: z.boolean(),
});
const mutationSchema = z.object({
  document: z.string(),
  event_id: eventId,
  state_revision: token,
  changed: z.literal(true),
  cleanup_failures: z.array(z.json()),
});

/** 원문/주체를 이전 작업 공간의 요청에 섞지 않도록 공개 연결 상태를 대조합니다. */
function connectionMatches(
  result: ConnectionResult,
  connectionId: string,
  scope: ReviewScope,
): boolean {
  return (
    result.ok &&
    result.data.status === 'connected' &&
    result.data.connectionId === connectionId &&
    result.data.userId === scope.userId &&
    result.data.policyRevision === scope.policyRevision &&
    result.data.selection?.tenant === scope.tenant &&
    result.data.selection.profile === scope.profileId
  );
}

/** 범위가 달라진 요청은 저장/현재 결과로 사용하지 않습니다. */
function scopeChanged(): { ok: false; error: ReviewError } {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message: '연결 또는 관점이 변경됐습니다. 현재 문서를 다시 선택해 주세요.',
    },
  };
}

/** 원문·지식·현재 권한을 함께 읽고 서로 다른 판본은 UI에서 저장을 막습니다. */
export async function loadReviewContext(
  connectionId: string,
  selection: ReviewSelection,
  scope: ReviewScope,
): Promise<ReviewOutcome<ReviewContext>> {
  try {
    const before = await connectionGateway.getState();
    if (!connectionMatches(before, connectionId, scope)) return scopeChanged();
    // 독립 조회를 함께 읽되 아래에서 문서·원문 판본·현재 권한을 다시 대조합니다.
    const [knowledge, body] = await Promise.all([
      knowledgeGateway.read({ connectionId, document: selection.document }),
      documentsGateway.content({ connectionId, document: selection.document }),
    ]);
    if (!knowledge.ok) return knowledge;
    if (!body.ok) return body;
    const after = await connectionGateway.getState();
    if (
      !connectionMatches(after, connectionId, scope) ||
      !after.ok ||
      after.data.status !== 'connected'
    )
      return scopeChanged();
    const access = knowledge.data.access;
    if (
      knowledge.data.document !== selection.document ||
      body.data.document !== selection.document ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision ||
      body.data.access.userId !== scope.userId ||
      body.data.access.tenant !== scope.tenant ||
      body.data.access.profileId !== scope.profileId ||
      body.data.access.policyRevision !== scope.policyRevision
    )
      return scopeChanged();
    const workspace = after.data.workspaces.find(
      (item: (typeof after.data.workspaces)[number]): boolean =>
        item.id === scope.tenant,
    );
    return {
      ok: true,
      data: {
        knowledge: knowledge.data,
        body: body.data.content,
        bodyRevision: body.data.revision,
        permissions: workspace ? workspace.permissions : [],
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '검토할 문서와 현재 권한을 읽을 수 없습니다.',
      },
    };
  }
}

/** 읽기와 쓰기 모두 편집 당시 범위를 main에 보내고 실제 응답 범위도 확인합니다. */
async function execute(
  request: WorkspaceRequest,
  scope: ReviewScope,
): Promise<ReviewOutcome<z.infer<typeof knowledgeValueSchema>>> {
  try {
    const result = await workspaceGateway.execute({
      ...request,
      expectedScope: {
        userId: scope.userId,
        tenant: scope.tenant,
        profileId: scope.profileId,
        policyRevision: scope.policyRevision,
      },
    });
    if (!result.ok) return result;
    const after = await connectionGateway.getState();
    const access = result.data.access;
    if (
      !connectionMatches(after, request.connectionId, scope) ||
      result.data.operation !== request.operation ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision
    )
      return scopeChanged();
    return { ok: true, data: result.data.data };
  } catch {
    return {
      ok: false,
      error: {
        code: ['review', 'policy', 'reviewUndo', 'policyUndo'].includes(
          request.operation,
        )
          ? 'outcome_unknown'
          : 'bridge_unavailable',
        message:
          '응답을 확인하지 못했습니다. 저장을 반복하지 말고 문서 이력을 확인해 주세요.',
      },
    };
  }
}

/** 검토 이력의 실제 페이지와 보류 상태를 읽고 전체 이력으로 확대하지 않습니다. */
export async function loadReviewEvents(
  connectionId: string,
  document: string,
  scope: ReviewScope,
  cursor: string | null = null,
): Promise<ReviewOutcome<ReviewEventPage>> {
  const result = await execute(
    {
      connectionId,
      operation: 'events',
      input: { document, limit: 20, cursor },
    },
    scope,
  );
  if (!result.ok) return result;
  const parsed = pageSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.document !== document)
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message: '검토 이력의 응답을 확인할 수 없습니다.',
      },
    };
  const data = parsed.data;
  return {
    ok: true,
    data: {
      items: data.items,
      nextCursor: data.next_cursor,
      stateRevision: data.state_revision,
      pendingHistory: data.pending_history,
      complete: data.complete,
      truncated: data.truncated,
      skippedCount: data.skipped.length,
      requiresRefresh: data.requires_refresh,
    },
  };
}

/** 선택 이벤트의 당시 값과 이유를 실제 단건 API에서 읽습니다. */
export async function loadReviewEvent(
  connectionId: string,
  document: string,
  id: string,
  scope: ReviewScope,
): Promise<ReviewOutcome<ReviewEventDetail>> {
  const result = await execute(
    { connectionId, operation: 'event', input: { document, event_id: id } },
    scope,
  );
  if (!result.ok) return result;
  const parsed = detailSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.document !== document ||
    parsed.data.event.id !== id
  )
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message: '선택한 검토 이벤트의 응답을 확인할 수 없습니다.',
      },
    };
  return {
    ok: true,
    data: {
      event: parsed.data.event,
      stateRevision: parsed.data.state_revision,
      pending: parsed.data.pending,
    },
  };
}

/** 성공 응답은 실제 새 이벤트와 상태 판본으로 확인하며 자동 재전송하지 않습니다. */
export async function saveReviewOperation(
  request: WorkspaceRequest & {
    operation: Extract<
      WorkspaceOperation,
      'review' | 'reviewUndo' | 'policy' | 'policyUndo'
    >;
  },
  scope: ReviewScope,
): Promise<ReviewOutcome<ReviewMutation>> {
  const result = await execute(request, scope);
  if (!result.ok) return result;
  const parsed = mutationSchema.safeParse(result.data);
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '저장 결과의 이벤트를 확인하지 못했습니다. 다시 저장하지 말고 이력을 확인해 주세요.',
      },
    };
  return {
    ok: true,
    data: {
      eventId: parsed.data.event_id,
      stateRevision: parsed.data.state_revision,
      cleanupWarningCount: parsed.data.cleanup_failures.length,
    },
  };
}
