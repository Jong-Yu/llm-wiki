import {
  NOTIFICATION_CHANNELS,
  notificationApproveSchema,
  notificationContinueResultSchema,
  notificationContinueSchema,
  notificationDecideSchema,
  notificationDetailResultSchema,
  notificationInspectionResultSchema,
  notificationListResultSchema,
  notificationListSchema,
  notificationMarkReadSchema,
  notificationDismissSchema,
  notificationMutationResultSchema,
  notificationPageResultSchema,
  notificationPageSchema,
  notificationReadSchema,
  notificationReadStateResultSchema,
  notificationCorrectSchema,
  notificationRetryPageSchema,
  notificationRetryPageResultSchema,
  notificationCancelRetrySchema,
  notificationCancelRetryResultSchema,
} from '@contracts/notifications.contract';
import type { NotificationsBridge } from '@contracts/notifications.contract';
import type { BrowserWindow } from 'electron';
import type { NotificationService } from '@main/backend/NotificationService';
import { createIpcRegistrar } from './registerIpcHandlers';
import type { IpcContracts } from './registerIpcHandlers';

const contracts = {
  correct: {
    channel: NOTIFICATION_CHANNELS.correct,
    request: notificationCorrectSchema,
    result: notificationMutationResultSchema,
  },
  retryPage: {
    channel: NOTIFICATION_CHANNELS.retryPage,
    request: notificationRetryPageSchema,
    result: notificationRetryPageResultSchema,
  },
  cancelRetry: {
    channel: NOTIFICATION_CHANNELS.cancelRetry,
    request: notificationCancelRetrySchema,
    result: notificationCancelRetryResultSchema,
  },
  list: {
    channel: NOTIFICATION_CHANNELS.list,
    request: notificationListSchema,
    result: notificationListResultSchema,
  },
  read: {
    channel: NOTIFICATION_CHANNELS.read,
    request: notificationReadSchema,
    result: notificationDetailResultSchema,
  },
  markRead: {
    channel: NOTIFICATION_CHANNELS.markRead,
    request: notificationMarkReadSchema,
    result: notificationReadStateResultSchema,
  },
  dismiss: {
    channel: NOTIFICATION_CHANNELS.dismiss,
    request: notificationDismissSchema,
    result: notificationReadStateResultSchema,
  },
  decide: {
    channel: NOTIFICATION_CHANNELS.decide,
    request: notificationDecideSchema,
    result: notificationMutationResultSchema,
  },
  approve: {
    channel: NOTIFICATION_CHANNELS.approve,
    request: notificationApproveSchema,
    result: notificationMutationResultSchema,
  },
  inspect: {
    channel: NOTIFICATION_CHANNELS.inspect,
    request: notificationReadSchema,
    result: notificationInspectionResultSchema,
  },
  continue: {
    channel: NOTIFICATION_CHANNELS.continue,
    request: notificationContinueSchema,
    result: notificationContinueResultSchema,
  },
  page: {
    channel: NOTIFICATION_CHANNELS.page,
    request: notificationPageSchema,
    result: notificationPageResultSchema,
  },
} satisfies IpcContracts<NotificationsBridge, typeof NOTIFICATION_CHANNELS>;

/** 허용 창과 엄격한 입력·응답 계약 안에서만 알림을 공개합니다. */
export function registerNotificationHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: NotificationService,
): void {
  const { validated } = createIpcRegistrar(getWindow, rendererLocation, {
    invalidRequest: '알림 요청을 확인해 주세요.',
    unexpected: {
      code: 'notification_unavailable',
      message:
        '알림 상태를 확인하지 못했습니다. 저장 여부를 다시 조회해 주세요.',
    },
  });
  validated(contracts.correct, service.correct.bind(service));
  validated(contracts.retryPage, service.retryPage.bind(service));
  validated(contracts.cancelRetry, service.cancelRetry.bind(service));
  validated(contracts.list, service.list.bind(service));
  validated(contracts.read, service.read.bind(service));
  validated(contracts.markRead, service.markRead.bind(service));
  validated(contracts.dismiss, service.dismiss.bind(service));
  validated(contracts.decide, service.decide.bind(service));
  validated(contracts.approve, service.approve.bind(service));
  validated(contracts.inspect, service.inspect.bind(service));
  validated(contracts.continue, service.continue.bind(service));
  validated(contracts.page, service.page.bind(service));
}
