import type {
  NotificationsBridge,
  NotificationApproveRequest,
  NotificationContinueRequest,
  NotificationContinueResult,
  NotificationDecideRequest,
  NotificationDetailResult,
  NotificationInspectionResult,
  NotificationListRequest,
  NotificationListResult,
  NotificationMarkReadRequest,
  NotificationMutationResult,
  NotificationPageRequest,
  NotificationPageResult,
  NotificationReadRequest,
  NotificationReadStateResult,
  NotificationCorrectRequest,
  NotificationRetryPageRequest,
  NotificationRetryPageResult,
  NotificationCancelRetryRequest,
  NotificationCancelRetryResult,
} from '@contracts/notifications.contract';

/** 최신 앱의 제한된 알림 bridge만 사용합니다. */
function getBridge(): NotificationsBridge {
  if (!window.wiki?.notifications)
    throw new Error('알림은 최신 데스크톱 앱에서 확인해 주세요.');
  return window.wiki.notifications;
}
/** 서버 알림 지원 여부를 확인합니다. */
export function hasNotificationsBridge(): boolean {
  return !!window.wiki?.notifications;
}
export const notificationsGateway: NotificationsBridge = {
  correct: (
    request: NotificationCorrectRequest,
  ): Promise<NotificationMutationResult> => getBridge().correct(request),
  retryPage: (
    request: NotificationRetryPageRequest,
  ): Promise<NotificationRetryPageResult> => getBridge().retryPage(request),
  cancelRetry: (
    request: NotificationCancelRetryRequest,
  ): Promise<NotificationCancelRetryResult> => getBridge().cancelRetry(request),
  list: (request: NotificationListRequest): Promise<NotificationListResult> =>
    getBridge().list(request),
  read: (request: NotificationReadRequest): Promise<NotificationDetailResult> =>
    getBridge().read(request),
  markRead: (
    request: NotificationMarkReadRequest,
  ): Promise<NotificationReadStateResult> => getBridge().markRead(request),
  decide: (
    request: NotificationDecideRequest,
  ): Promise<NotificationMutationResult> => getBridge().decide(request),
  approve: (
    request: NotificationApproveRequest,
  ): Promise<NotificationMutationResult> => getBridge().approve(request),
  inspect: (
    request: NotificationReadRequest,
  ): Promise<NotificationInspectionResult> => getBridge().inspect(request),
  continue: (
    request: NotificationContinueRequest,
  ): Promise<NotificationContinueResult> => getBridge().continue(request),
  page: (request: NotificationPageRequest): Promise<NotificationPageResult> =>
    getBridge().page(request),
};
