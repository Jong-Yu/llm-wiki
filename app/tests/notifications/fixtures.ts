import { notificationDetailResultSchema } from '@contracts/notifications.contract';
import type {
  NotificationApproveRequest,
  NotificationContinueRequest,
  NotificationDecideRequest,
  NotificationDetailResult,
  NotificationInspectionResult,
  NotificationItem,
  NotificationListRequest,
  NotificationListResult,
  NotificationMarkReadRequest,
  NotificationMutationResult,
  NotificationPageRequest,
  NotificationPageResult,
  NotificationReadRequest,
  NotificationReadStateResult,
  NotificationSession,
  NotificationWorkflow,
  NotificationsBridge,
} from '@contracts/notifications.contract';
import {
  fixtureRevision,
  installFixtureBridge,
} from '../document-tasks/fixtures';

type Detail = Extract<NotificationDetailResult, { ok: true }>['data'];
type Method = 'list' | 'read' | 'page' | 'decide' | 'approve' | 'continue';
export const workflowId = '1'.repeat(32);
const deviceId = '2'.repeat(32);
const source = {
  source_id: '3'.repeat(32),
  source_version: '4'.repeat(32),
  source_sha256: fixtureRevision,
  registration_revision: fixtureRevision,
};
const actor = {
  user_id: 'fixture-user',
  tenant: 'fixture',
  profile_id: 'default',
};
const access = { ...actor, policy_revision: fixtureRevision };
const now = '2026-11-24T05:00:00Z';
const key = 'wiki-isolated-server-notifications';
type FixtureState = {
  detail: Detail;
  items: NotificationItem[];
  revision: number;
  ready: boolean;
  deny: boolean;
  calls: Record<string, number>;
  requests: Record<string, string[]>;
  fail: Method | null;
  lose: Method | null;
};

/** 격리된 170쪽·30경고 보고만 만들며 운영 자료를 읽지 않습니다. */
function initial(): FixtureState {
  const pages = Array.from(
    { length: 30 },
    (_: unknown, index: number): number => 2 + index * 5,
  );
  const workflow: NotificationWorkflow = {
    workflow_id: workflowId,
    revision: '1'.repeat(64),
    source_ref: source,
    conversion_ref: {
      conversion_id: workflowId,
      conversion_revision: fixtureRevision,
    },
    title: '합성 시스템 아키텍처',
    target_document: '합성 시스템 아키텍처.md',
    state: 'review',
    pages: pages.map((page: number): NotificationWorkflow['pages'][number] => ({
      page,
      state: 'pending',
    })),
    approval: null,
    execution: null,
    resume_request_id: '5'.repeat(32),
    created_at: now,
    updated_at: now,
  };
  const components: Record<string, string> = {};
  const units = Array.from(
    { length: 170 },
    (
      _: unknown,
      index: number,
    ): NonNullable<Detail['conversion']>['manifest']['units'][number] => {
      const unit_id = `page_${index + 1}`;
      components[unit_id] =
        `${index + 1}쪽 UI 검증 전용 합성 문자입니다.\n실제 사용자 원문이 아닙니다.\n알림 읽기와 문자 사용 승인을 구별합니다.`;
      return {
        unit_id,
        location: { kind: 'pages', start: index + 1, end: index + 1 },
      };
    },
  );
  const detail: Detail = {
    workflow,
    access,
    events: [
      {
        event_id: '6'.repeat(32),
        kind: 'approval_required',
        created_at: now,
        actor,
      },
    ],
    conversion: {
      manifest: {
        id: workflowId,
        source_ref: source,
        method: 'ocr',
        complete: false,
        unread_ranges: pages.map(
          (page: number): string =>
            `page ${page}: ocr_low_or_missing_confidence_text_retained_manual_review_required`,
        ),
        warnings: [
          'ocr_low_or_missing_confidence_text_retained_manual_review_required',
        ],
        units,
      },
      revision: fixtureRevision,
      components,
    },
  };
  const items: NotificationItem[] = Array.from(
    { length: 9 },
    (_: unknown, index: number): NotificationItem => ({
      notification_id: (100 + index).toString(16).padStart(32, '0'),
      workflow_id: workflowId,
      sequence: index + 1,
      kind: index === 0 ? 'approval_required' : 'completed',
      created_at: now,
      read_at: null,
      title: index === 0 ? workflow.title : `합성 처리 기록 ${index + 1}`,
      state: index === 0 ? 'review' : 'complete',
      warning_count: index === 0 ? pages.length : 0,
      source_ref: source,
      conversion_ref: workflow.conversion_ref,
    }),
  );
  return {
    detail,
    items,
    revision: 1,
    ready: true,
    deny: false,
    calls: {},
    requests: {},
    fail: null,
    lose: null,
  };
}
let state = initial();
const stored = localStorage.getItem(key);
if (stored) {
  const value: unknown = JSON.parse(stored);
  if (
    value &&
    typeof value === 'object' &&
    'detail' in value &&
    notificationDetailResultSchema.safeParse({ ok: true, data: value.detail })
      .success
  ) {
    // 이 fixture의 재시작 영속성은 실제 서버 보존 시험과 별도로 검사합니다.
    Object.assign(state, value);
  }
}
/** 서버 역할의 합성 상태만 브라우저 테스트 저장소에 보관합니다. */
function persist(): void {
  localStorage.setItem(key, JSON.stringify(state));
}
/** 각 요청을 실제 계약 범위와 비교하고 실패·응답 유실을 재현합니다. */
function enter(method: Method, request: NotificationSession): void {
  state.calls[method] = (state.calls[method] ?? 0) + 1;
  if ('requestId' in request && typeof request.requestId === 'string') {
    state.requests[method] = [
      ...(state.requests[method] ?? []),
      request.requestId,
    ];
  }
  if (
    request.connectionId !== 'fixture' ||
    request.expectedScope.userId !== actor.user_id ||
    request.expectedScope.tenant !== actor.tenant
  )
    throw new Error('Fixture scope mismatch');
  if (state.fail === method) {
    state.fail = null;
    persist();
    throw new Error('합성 네트워크 실패');
  }
  persist();
}
/** CAS 충돌에서는 다른 기기의 최신 확인을 덮어쓰지 않습니다. */
function mutation(
  request:
    | NotificationDecideRequest
    | NotificationApproveRequest
    | NotificationContinueRequest,
): void {
  if (request.expectedRevision !== state.detail.workflow.revision)
    throw new Error(
      '다른 PC에서 확인 내역이 바뀌었습니다. 다시 확인해 주세요.',
    );
  state.revision += 1;
  state.detail.workflow.revision = state.revision
    .toString(16)
    .padStart(64, '0');
}
/** 응답이 유실되어도 합성 서버에는 완료된 동작을 남깁니다. */
function receipt(method: Method): void {
  persist();
  if (state.lose === method) {
    state.lose = null;
    persist();
    throw new Error('합성 응답 유실: 저장 여부를 다시 확인해 주세요.');
  }
}
const denied = {
  ok: false,
  error: {
    code: 'forbidden',
    status: 403,
    message: '현재 자료에 접근할 수 없습니다.',
  },
} as const;
const bridge: NotificationsBridge = {
  list: async (
    request: NotificationListRequest,
  ): Promise<NotificationListResult> => {
    enter('list', request);
    if (state.deny) return denied;
    const rows = state.items.map(
      (item: NotificationItem): NotificationItem => ({
        ...item,
        state:
          item.kind === 'approval_required'
            ? state.detail.workflow.state
            : item.state,
      }),
    );
    const items = rows.filter((item: NotificationItem): boolean =>
      request.filter === 'unread'
        ? !item.read_at
        : request.filter === 'approval'
          ? item.state === 'review'
          : true,
    );
    const offset = request.cursor ? Number(request.cursor) : 0;
    return {
      ok: true,
      data: {
        items: items.slice(offset, offset + 5),
        next_cursor: offset + 5 < items.length ? String(offset + 5) : null,
        unread_count: rows.filter(
          (item: NotificationItem): boolean => !item.read_at,
        ).length,
        approval_count: rows.filter(
          (item: NotificationItem): boolean => item.state === 'review',
        ).length,
        latest_sequence: 9,
        access,
      },
    };
  },
  read: async (
    request: NotificationReadRequest,
  ): Promise<NotificationDetailResult> => {
    enter('read', request);
    return state.deny
      ? denied
      : notificationDetailResultSchema.parse({
          ok: true,
          data: structuredClone(state.detail),
        });
  },
  markRead: async (
    request: NotificationMarkReadRequest,
  ): Promise<NotificationReadStateResult> => {
    state.calls.markRead = (state.calls.markRead ?? 0) + 1;
    if (state.deny) return denied;
    state.items.forEach((item: NotificationItem): void => {
      if (request.notificationIds.includes(item.notification_id))
        item.read_at = request.read ? now : null;
    });
    persist();
    return {
      ok: true,
      data: { updated: request.notificationIds.length, access },
    };
  },
  decide: async (
    request: NotificationDecideRequest,
  ): Promise<NotificationMutationResult> => {
    enter('decide', request);
    if (state.deny) return denied;
    mutation(request);
    request.decisions.forEach(
      (decision: NotificationDecideRequest['decisions'][number]): void => {
        const page = state.detail.workflow.pages.find(
          (item: NotificationWorkflow['pages'][number]): boolean =>
            item.page === decision.page,
        );
        if (page) page.state = decision.state;
      },
    );
    receipt('decide');
    return {
      ok: true,
      data: {
        workflow: structuredClone(state.detail.workflow),
        replayed: false,
        access,
      },
    };
  },
  approve: async (
    request: NotificationApproveRequest,
  ): Promise<NotificationMutationResult> => {
    enter('approve', request);
    if (state.deny) return denied;
    if (
      state.detail.workflow.pages.some(
        (page: NotificationWorkflow['pages'][number]): boolean =>
          page.state !== 'usable',
      )
    )
      throw new Error('Unconfirmed page approval');
    mutation(request);
    state.detail.workflow.state = 'approved';
    state.detail.workflow.approval = {
      request_id: request.requestId,
      approved_at: now,
      actor,
      device_id: deviceId,
      device_name: 'UI 검증 PC',
    };
    receipt('approve');
    return {
      ok: true,
      data: {
        workflow: structuredClone(state.detail.workflow),
        replayed: false,
        access,
      },
    };
  },
  inspect: async (
    _request: NotificationReadRequest,
  ): Promise<NotificationInspectionResult> =>
    state.deny
      ? denied
      : {
          ok: true,
          data: {
            ready: state.ready,
            blockers: state.ready ? [] : ['개인 AI 로그인이 필요합니다.'],
            deviceId,
            deviceName: 'UI 검증 PC',
            checkedAt: now,
          },
        },
  continue: async (
    request: NotificationContinueRequest,
  ): Promise<Awaited<ReturnType<NotificationsBridge['continue']>>> => {
    enter('continue', request);
    if (state.deny) return denied;
    if (
      !['approved', 'claimed', 'failed', 'stopped'].includes(
        state.detail.workflow.state,
      ) ||
      !state.ready
    )
      throw new Error('Unapproved or duplicate execution');
    mutation(request);
    state.detail.workflow.state = 'running';
    state.detail.workflow.execution = {
      claim_id: request.requestId,
      device_id: deviceId,
      device_name: 'UI 검증 PC',
      claimed_at: now,
      job_id: '9'.repeat(32),
    };
    receipt('continue');
    return {
      ok: true,
      data: {
        workflow: structuredClone(state.detail.workflow),
        jobId: '9'.repeat(32),
        started: true,
      },
    };
  },
  page: async (
    request: NotificationPageRequest,
  ): Promise<NotificationPageResult> => {
    enter('page', request);
    if (state.deny) return denied;
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 850;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing canvas');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 600, 850);
    context.fillStyle = '#222';
    context.font = '24px sans-serif';
    context.fillText(`UI 검증용 합성 PDF ${request.page}쪽`, 36, 64);
    context.font = '16px sans-serif';
    context.fillText('사용자 원문이 아닙니다.', 36, 110);
    return {
      ok: true,
      data: { page: request.page, dataUrl: canvas.toDataURL('image/png') },
    };
  },
};

/** 실제 화면에만 합성 bridge를 연결하고 운영 네트워크는 사용하지 않습니다. */
export function installNotifications(): void {
  installFixtureBridge();
  if (!window.wiki) throw new Error('Missing fixture bridge');
  Object.defineProperty(window.wiki, 'notifications', { value: bridge });
  Reflect.set(window, '__notifications', {
    snapshot: (): FixtureState => structuredClone(state),
    reset: (): void => {
      state = initial();
      persist();
    },
    fail: (method: Method): void => {
      state.fail = method;
      persist();
    },
    lose: (method: Method): void => {
      state.lose = method;
      persist();
    },
    deny: (): void => {
      state.deny = true;
      persist();
    },
    ready: (value: boolean): void => {
      state.ready = value;
      persist();
    },
    allUsable: (): void => {
      state.detail.workflow.pages.forEach(
        (page: NotificationWorkflow['pages'][number]): void => {
          page.state = 'usable';
        },
      );
      persist();
    },
    otherPc: (): void => {
      state.detail.workflow.state = 'running';
      state.detail.workflow.execution = {
        claim_id: 'a'.repeat(32),
        device_id: 'b'.repeat(32),
        device_name: '다른 작업 PC',
        claimed_at: now,
        job_id: '9'.repeat(32),
      };
      persist();
    },
    resumeState: (value: 'claimed' | 'failed' | 'stopped'): void => {
      state.detail.workflow.state = value;
      state.detail.workflow.execution = {
        claim_id: 'a'.repeat(32),
        device_id: deviceId,
        device_name: 'UI 검증 PC',
        claimed_at: now,
        job_id: '9'.repeat(32),
      };
      state.detail.workflow.approval = {
        request_id: 'c'.repeat(32),
        approved_at: now,
        actor,
        device_id: deviceId,
        device_name: 'UI 검증 PC',
      };
      persist();
    },
    complete: (): void => {
      state.detail.workflow.state = 'complete';
      persist();
    },
    missingText: (): void => {
      if (state.detail.conversion)
        delete state.detail.conversion.components.page_2;
      persist();
    },
    obsolete: (reason: 'source_changed' | 'report_changed'): void => {
      state.detail.workflow.state = 'stopped';
      state.detail.workflow.blocked_reason = reason;
      persist();
    },
  });
}
