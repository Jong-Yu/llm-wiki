import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  DOCUMENT_TASK_CHANNELS,
  documentTaskCreateSchema,
  documentTaskSessionSchema,
  documentTaskReadSchema,
  documentTaskResultSchema,
  documentTaskListResultSchema,
  documentTaskDetailResultSchema,
} from '@contracts/documentTasks.contract';
import type {
  DocumentTaskResult,
  DocumentTaskListResult,
  DocumentTaskDetailResult,
} from '@contracts/documentTasks.contract';
import type { DocumentTaskService } from '@main/backend/DocumentTaskService';
import { isAppSender } from './isAppSender';

type Result =
  | DocumentTaskResult
  | DocumentTaskListResult
  | DocumentTaskDetailResult;

/** 허용 창·단일 인자·업무 스키마를 검사한 뒤 보호된 문서 작업만 공개합니다. */
export function registerDocumentTaskHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: DocumentTaskService,
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
              message: '작업 조회 입력을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'task_unavailable',
              message:
                '작업 기록을 확인할 수 없습니다. 기존 기록은 보존됩니다.',
            },
          };
        }
      },
    );
  };
  register(
    DOCUMENT_TASK_CHANNELS.create,
    async (value: unknown): Promise<DocumentTaskResult> =>
      documentTaskResultSchema.parse(
        await service.create(documentTaskCreateSchema.parse(value)),
      ),
  );
  register(
    DOCUMENT_TASK_CHANNELS.list,
    async (value: unknown): Promise<DocumentTaskListResult> =>
      documentTaskListResultSchema.parse(
        await service.list(documentTaskSessionSchema.parse(value)),
      ),
  );
  register(
    DOCUMENT_TASK_CHANNELS.read,
    async (value: unknown): Promise<DocumentTaskDetailResult> =>
      documentTaskDetailResultSchema.parse(
        await service.read(documentTaskReadSchema.parse(value)),
      ),
  );
}
