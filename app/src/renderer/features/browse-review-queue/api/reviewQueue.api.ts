import { sameAccessRevision } from '@contracts/connection.contract';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { workspaceGateway } from '@renderer/platform/workspace';
import {
  reviewQueueSchema,
  reviewStateSchema,
} from '../model/reviewQueue.schema';
import { presentReviewQueue } from '../model/reviewQueuePresentation';
import type {
  ReviewQueuePage,
  ReviewQueueState,
} from '../model/reviewQueue.types';

type ReviewScope = {
  connectionId: string;
  expectedScope: WorkspaceScope;
  domain: string | null;
  viewpoint: string | null;
};

/** 권한 변경과 목록 변경은 일반 조회 실패와 구분해 이전 자료의 사용을 제한합니다. */
export class ReviewQueueError extends Error {
  readonly code: string;
  readonly invalidatesScope: boolean;
  readonly requiresRefresh: boolean;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ReviewQueueError';
    this.code = code;
    this.invalidatesScope =
      status === 401 ||
      status === 403 ||
      [
        'forbidden',
        'unauthorized',
        'scope_changed',
        'subject_changed',
        'access_changed',
        'connection_changed',
        'policy_changed',
        'selection_required',
        'not_connected',
        'connection_required',
        'access_denied',
        'access_unavailable',
      ].includes(code);
    this.requiresRefresh = [
      'catalog_changed',
      'invalid_cursor',
      'snapshot_changed',
    ].includes(code);
  }
}

/** bridge가 예외로 전달한 명시 권한 오류도 성공 봉투의 오류와 같은 기준으로 처리합니다. */
function rethrowKnownFailure(cause: unknown): never {
  if (cause instanceof ReviewQueueError) throw cause;
  if (cause !== null && typeof cause === 'object') {
    const code =
      'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : 'request_failed';
    const status =
      'status' in cause && typeof cause.status === 'number'
        ? cause.status
        : undefined;
    const message =
      'message' in cause && typeof cause.message === 'string'
        ? cause.message
        : '현재 조회 범위를 확인하지 못했습니다. 다시 조회해 주세요.';
    const error = new ReviewQueueError(code, message, status);
    if (error.invalidatesScope || error.requiresRefresh) throw error;
  }
  throw cause;
}

/** 현재 로그인과 선택 범위를 고정하며 다른 설정을 대신 선택하지 않습니다. */
async function readScope(): Promise<ReviewScope> {
  const result = await connectionGateway.getState().catch(rethrowKnownFailure);
  if (!result.ok)
    throw new ReviewQueueError(result.error.code, result.error.message);
  const state = result.data;
  if (state.status !== 'connected' || !state.selection)
    throw new ReviewQueueError(
      'connection_required',
      '작업 공간에 연결한 뒤 검토 목록을 확인해 주세요.',
    );
  const selection = state.selection;
  const membership = state.workspaces.find(
    (item: (typeof state.workspaces)[number]): boolean =>
      item.id === selection.tenant,
  );
  const profile = membership?.profiles.find(
    (item: NonNullable<typeof membership>['profiles'][number]): boolean =>
      item.id === selection.profile,
  );
  if (!membership?.permissions.includes('read') || !profile)
    throw new ReviewQueueError(
      'access_denied',
      '현재 작업 공간의 조회 권한을 확인할 수 없습니다.',
    );
  return {
    connectionId: state.connectionId,
    expectedScope: {
      userId: state.userId,
      tenant: selection.tenant,
      profileId: selection.profile,
      policyRevision: state.policyRevision,
      ...(state.accessRevision ? { accessRevision: state.accessRevision } : {}),
    },
    domain: profile.domain,
    viewpoint: profile.viewpoint,
  };
}

/** 감사용 전체 정책 revision 대신 본인 접근 revision이 있으면 이를 우선합니다. */
function scopeKey(scope: ReviewScope): string {
  return JSON.stringify([
    scope.connectionId,
    scope.expectedScope.userId,
    scope.expectedScope.tenant,
    scope.expectedScope.profileId,
    scope.domain,
    scope.viewpoint,
    scope.expectedScope.accessRevision ?? scope.expectedScope.policyRevision,
  ]);
}

/** 실제 tenant 집계 한 페이지만 조회하고 원시 종류·판본·범위 불일치를 거부합니다. */
export async function readReviewQueuePage(
  states: readonly ReviewQueueState[],
  cursor: string | null,
): Promise<ReviewQueuePage> {
  const selected = reviewStateSchema
    .array()
    .min(1)
    .max(3)
    .parse([...states]);
  if (new Set(selected).size !== selected.length)
    throw new ReviewQueueError(
      'invalid_request',
      '중복되지 않은 검토 상태를 선택해 주세요.',
    );
  const scope = await readScope();
  const result = await workspaceGateway
    .execute({
      connectionId: scope.connectionId,
      expectedScope: scope.expectedScope,
      operation: 'reviewQueue',
      input: {
        coverage: 'tenant',
        documents: [],
        correspondence_ids: [],
        states: selected,
        limit: 20,
        cursor,
      },
    })
    .catch(rethrowKnownFailure);
  const latest = await readScope();
  if (scopeKey(scope) !== scopeKey(latest))
    throw new ReviewQueueError(
      'scope_changed',
      '조회 중 연결 범위가 변경되어 이전 검토 목록을 숨겼습니다.',
    );
  if (!result.ok)
    throw new ReviewQueueError(
      result.error.code,
      result.error.message,
      result.error.status,
    );
  const response = result.data;
  const access = response.access;
  if (
    response.connectionId !== scope.connectionId ||
    response.operation !== 'reviewQueue' ||
    access.userId !== scope.expectedScope.userId ||
    access.tenant !== scope.expectedScope.tenant ||
    access.profileId !== scope.expectedScope.profileId ||
    access.domain !== scope.domain ||
    access.viewpoint !== scope.viewpoint ||
    !sameAccessRevision(access, scope.expectedScope)
  )
    throw new ReviewQueueError(
      'scope_changed',
      '서버의 현재 조회 범위를 확인할 수 없어 이전 목록을 숨겼습니다.',
    );
  const parsed = reviewQueueSchema.safeParse(response.data);
  if (!parsed.success)
    throw new ReviewQueueError(
      'invalid_response',
      '검토 목록 응답의 항목과 버전을 확인할 수 없습니다.',
    );
  const value = parsed.data;
  const keys = new Set(
    value.items.map((item: (typeof value.items)[number]): string => item.key),
  );
  if (value.scope.tenant !== scope.expectedScope.tenant)
    throw new ReviewQueueError(
      'scope_changed',
      '검토 목록의 작업 공간이 달라 이전 목록을 숨겼습니다.',
    );
  if (
    JSON.stringify([...value.scope.states].sort()) !==
      JSON.stringify([...selected].sort()) ||
    keys.size !== value.items.length ||
    value.total_items < value.items.length ||
    value.items.some(
      (item: (typeof value.items)[number]): boolean =>
        !selected.includes(item.status),
    ) ||
    (cursor !== null && value.next_cursor === cursor) ||
    (value.next_cursor !== null && value.items.length === 0) ||
    value.scope_complete !== (value.skipped.length === 0) ||
    value.complete !== (value.scope_complete && value.next_cursor === null)
  )
    throw new ReviewQueueError(
      'invalid_response',
      '검토 목록의 선택 범위 또는 페이지 상태가 일치하지 않습니다.',
    );
  return presentReviewQueue(value, scopeKey(scope));
}
