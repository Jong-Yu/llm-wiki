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
  notificationMutationResultSchema,
  notificationPageResultSchema,
  notificationPageSchema,
  notificationReadSchema,
  notificationReadStateResultSchema,
} from '@contracts/notifications.contract';
import type {
  NotificationContinueResult,
  NotificationDetailResult,
  NotificationInspectionResult,
  NotificationListResult,
  NotificationMutationResult,
  NotificationPageResult,
  NotificationReadStateResult,
} from '@contracts/notifications.contract';
import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { NotificationService } from '@main/backend/NotificationService';
import { isAppSender } from './isAppSender';

type Result =
  | NotificationContinueResult
  | NotificationDetailResult
  | NotificationInspectionResult
  | NotificationListResult
  | NotificationMutationResult
  | NotificationPageResult
  | NotificationReadStateResult;
/** 허용 창과 엄격한 입력·응답 계약 안에서만 알림을 공개합니다. */
export function registerNotificationHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: NotificationService,
): void {
  const register = (
    channel: string,
    operation: (value: unknown) => Promise<Result>,
  ): void => {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<Result> => {
        if (!isAppSender(event, getWindow, rendererLocation))
          return {
            ok: false,
            error: {
              code: 'forbidden',
              message: '허용되지 않은 앱 요청입니다.',
            },
          };
        if (args.length !== 1)
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '알림 요청을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'notification_unavailable',
              message:
                '알림 상태를 확인하지 못했습니다. 저장 여부를 다시 조회해 주세요.',
            },
          };
        }
      },
    );
  };
  register(
    NOTIFICATION_CHANNELS.list,
    async (value: unknown): Promise<NotificationListResult> =>
      notificationListResultSchema.parse(
        await service.list(notificationListSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.read,
    async (value: unknown): Promise<NotificationDetailResult> =>
      notificationDetailResultSchema.parse(
        await service.read(notificationReadSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.markRead,
    async (value: unknown): Promise<NotificationReadStateResult> =>
      notificationReadStateResultSchema.parse(
        await service.markRead(notificationMarkReadSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.decide,
    async (value: unknown): Promise<NotificationMutationResult> =>
      notificationMutationResultSchema.parse(
        await service.decide(notificationDecideSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.approve,
    async (value: unknown): Promise<NotificationMutationResult> =>
      notificationMutationResultSchema.parse(
        await service.approve(notificationApproveSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.inspect,
    async (value: unknown): Promise<NotificationInspectionResult> =>
      notificationInspectionResultSchema.parse(
        await service.inspect(notificationReadSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.continue,
    async (value: unknown): Promise<NotificationContinueResult> =>
      notificationContinueResultSchema.parse(
        await service.continue(notificationContinueSchema.parse(value)),
      ),
  );
  register(
    NOTIFICATION_CHANNELS.page,
    async (value: unknown): Promise<NotificationPageResult> =>
      notificationPageResultSchema.parse(
        await service.page(notificationPageSchema.parse(value)),
      ),
  );
}
