import type {
  NotificationDetailResult,
  NotificationSession,
  NotificationWorkflow,
} from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';

export type NotificationDetail = Extract<
  NotificationDetailResult,
  { ok: true }
>['data'];
export type ReviewPage = NotificationWorkflow['pages'][number];

/** 현재 사용자와 정책 판본을 모든 보호된 알림 요청에 고정합니다. */
export function notificationSession(
  scope: SourceConversionScope,
): NotificationSession {
  return {
    connectionId: scope.connectionId,
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
      ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
    },
  };
}

/** 작업 주소는 실행 명령 없이 서버의 고정 보고 식별자만 전달합니다. */
export function notificationWorkflowPath(workflowId: string): string {
  return `/tasks?${new URLSearchParams({ workflowId })}`;
}

/** 서버에 저장된 상태를 기기의 실행 여부와 섞지 않고 표시합니다. */
export function workflowStateLabel(
  state: string,
  blockedReason?: 'source_changed' | 'report_changed',
): string {
  if (blockedReason === 'source_changed') return '원본 변경 · 다시 검토 필요';
  if (blockedReason === 'report_changed')
    return '새 변환 보고 · 다시 검토 필요';
  switch (state) {
    case 'review':
      return '승인 대기';
    case 'approved':
      return '승인됨 · 진행 전';
    case 'claimed':
      return '실행 기기 확보됨 · 접수 확인 중';
    case 'running':
      return '처리 중';
    case 'complete':
      return '처리 완료';
    case 'failed':
      return '처리 실패';
    case 'stopped':
      return '처리 중단';
    default:
      return '상태 확인 필요';
  }
}

/** 알림이 발생한 사건과 현재 작업 상태는 별개로 읽습니다. */
export function notificationEventLabel(kind: string): string {
  switch (kind) {
    case 'approval_required':
      return '문자 사용 승인 요청';
    case 'completed':
      return '처리 완료';
    case 'failed':
      return '처리 실패';
    case 'stopped':
      return '처리 중단';
    case 'pages_decided':
      return '쪽 확인 저장';
    case 'approved':
      return '문자 사용 승인';
    case 'claimed':
      return '실행 기기 확보';
    case 'running':
      return '처리 시작';
    default:
      return '처리 기록';
  }
}

/** 해당 쪽의 원문 위치가 확인되는 보관 문자만 대조에 사용합니다. */
export function pageText(
  detail: NotificationDetail,
  page: number,
): string | null {
  const conversion = detail.conversion;
  if (!conversion) return null;
  const contents = conversion.manifest.units.flatMap(
    (
      unit: NonNullable<
        NotificationDetail['conversion']
      >['manifest']['units'][number],
    ): string[] => {
      const location = unit.location;
      if (
        location.kind !== 'pages' ||
        location.start !== page ||
        location.end !== page
      )
        return [];
      const content = conversion.components[unit.unit_id];
      return typeof content === 'string' && content.trim() ? [content] : [];
    },
  );
  return contents.length ? contents.join('\n\n') : null;
}

/** 재전송되는 한 동작에 같은 요청 식별자를 쓰도록 생성합니다. */
export function notificationRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** 보호된 응답의 접근 거부에서는 이미 표시된 본문도 즉시 숨깁니다. */
export function notificationAccessLost(error: {
  code: string;
  status?: number;
}): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    /scope|access|unauthorized|forbidden/.test(error.code)
  );
}
