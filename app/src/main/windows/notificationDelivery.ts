import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import { NotificationDelivery } from '@main/backend/NotificationDelivery';
import type { NotificationMessage } from '@main/backend/NotificationDelivery';
import type { ConnectionService } from '@main/backend/ConnectionService';
import type { ProcessRecovery } from '@main/backend/processRecovery';
import type { NotificationsBridge } from '@contracts/notifications.contract';
import { showAppWindow } from './appLifetime';
import { isRendererLocation } from './rendererLocation';

/** OS 표시 실패를 앱 기능과 분리하고 클릭으로 기존 앱 창의 선택만 바꿉니다. */
export function createNativeNotificationDelivery(
  connection: ConnectionService,
  notifications: Pick<NotificationsBridge, 'list' | 'read'>,
  recovery: ProcessRecovery,
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
): NotificationDelivery {
  return new NotificationDelivery(
    connection,
    notifications,
    recovery,
    (message: NotificationMessage, open: () => void): (() => void) => {
      if (!Notification.isSupported()) return (): void => {};
      const notification = new Notification({
        title: message.title,
        body: message.body,
        silent: false,
      });
      notification.on('click', open);
      notification.on('failed', (): void => {
        /* 서버 알림 목록은 계속 사용할 수 있습니다. */
      });
      notification.show();
      return (): void => {
        notification.removeListener('click', open);
        notification.close();
      };
    },
    (workflowId: string): void => {
      const window = getWindow();
      if (
        !window ||
        window.isDestroyed() ||
        !isRendererLocation(window.webContents.getURL(), rendererLocation)
      )
        return;
      showAppWindow(window);
      window.webContents.send('notifications:open-workflow', workflowId);
    },
  );
}
