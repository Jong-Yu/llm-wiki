import { notificationLocationKey } from '@contracts/notifications.contract';
import type { NotificationLocation } from '@contracts/notifications.contract';
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
type ConversionUnit = NonNullable<
  NotificationDetail['conversion']
>['manifest']['units'][number];
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
  return `/documents?${new URLSearchParams({ workflowId })}`;
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
      return '내용 확인 필요';
    case 'approved':
      return '등록 준비됨';
    case 'claimed':
      return '등록 접수 확인 중';
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
      return '내용 확인 필요';
    case 'completed':
      return '처리 완료';
    case 'failed':
      return '처리 실패';
    case 'stopped':
      return '처리 중단';
    case 'pages_decided':
      return '페이지 내용 확인';
    case 'page_corrected':
    case 'correction_saved':
      return '페이지 내용 수정';
    case 'approved':
      return '등록 내용 확정';
    case 'claimed':
      return '등록 접수';
    case 'running':
      return '처리 시작';
    default:
      return '처리 기록';
  }
}

/** 선택한 위치에 고정된 수정 내용을 원래 변환 문자와 구별해 읽습니다. */
export function contentText(
  detail: NotificationDetail,
  location: NotificationLocation,
): string | null {
  const key = notificationLocationKey(location);
  const reference = detail.workflow.pages.find(
    (entry: ReviewPage): boolean => notificationLocationKey(entry) === key,
  )?.correction_ref;
  if (!reference) return originalContentText(detail, location);
  const matches = detail.corrections.filter(
    (entry: NotificationDetail['corrections'][number]): boolean =>
      notificationLocationKey(entry) === key &&
      entry.correction_ref.correction_id === reference.correction_id &&
      entry.correction_ref.correction_revision ===
        reference.correction_revision,
  );
  return matches.length === 1 ? (matches[0]?.content ?? null) : null;
}

/** 원래 보고의 빈 문자열과 실제로 없는 변환 단위를 구분합니다. */
export function originalContentText(
  detail: NotificationDetail,
  location: NotificationLocation,
): string | null {
  const conversion = detail.conversion;
  if (!conversion) return null;
  if (location.whole_document) return null;
  const units = conversion.manifest.units.filter(
    (unit: ConversionUnit): boolean =>
      location.unit_id !== undefined
        ? unit.unit_id === location.unit_id
        : unit.location.kind === 'pages' &&
          unit.location.start === location.page &&
          unit.location.end === location.page,
  );
  if (!units.length) return null;
  const contents = units.map(
    (unit: ConversionUnit): string | undefined =>
      conversion.components[unit.unit_id],
  );
  return contents.every(
    (value: string | undefined): value is string => typeof value === 'string',
  )
    ? contents.join('\n\n')
    : null;
}

/** 기존 페이지 호출에서도 같은 위치 검증을 사용합니다. */
export function pageText(
  detail: NotificationDetail,
  page: number,
): string | null {
  return contentText(detail, { page });
}

/** 보정 전 변환 문자는 원본 보고에서만 가져옵니다. */
export function originalPageText(
  detail: NotificationDetail,
  page: number,
): string | null {
  return originalContentText(detail, { page });
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
