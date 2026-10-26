import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { QuestionRunService } from '@main/backend/QuestionRunService';
import {
  QUESTION_RUN_CHANNELS,
  questionCreateSchema,
  questionCreationReceiptSchema,
  questionListSchema,
  questionReadSchema,
  questionStartSchema,
  questionCancelSchema,
} from '@contracts/questionRuns.contract';
import type {
  QuestionDetailResult,
  QuestionPageResult,
} from '@contracts/questionRuns.contract';
import { isAppSender } from './isAppSender';

type Result = QuestionDetailResult | QuestionPageResult;
/** 질문 전용 채널만 등록하고 신뢰하는 앱 창과 엄격한 요청 스키마를 확인합니다. */
export function registerQuestionRunHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: QuestionRunService,
): () => void {
  /** 임의 URL·셸·추가 인자가 실행 서비스에 도달하지 못하게 합니다. */
  function register(
    channel: string,
    operation: (value: unknown) => Promise<Result>,
  ): void {
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
              message: '질문 요청의 입력을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '질문 요청의 입력 또는 실행 환경을 확인해 주세요.',
            },
          };
        }
      },
    );
  }
  register(QUESTION_RUN_CHANNELS.create, (value: unknown): Promise<Result> =>
    service.create(questionCreateSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.creationReceipt,
    (value: unknown): Promise<Result> =>
      service.creationReceipt(questionCreationReceiptSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.list, (value: unknown): Promise<Result> =>
    service.list(questionListSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.read, (value: unknown): Promise<Result> =>
    service.read(questionReadSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.start, (value: unknown): Promise<Result> =>
    service.start(questionStartSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.cancel, (value: unknown): Promise<Result> =>
    service.cancel(questionCancelSchema.parse(value)),
  );
  return (): void => {
    for (const channel of Object.values(QUESTION_RUN_CHANNELS))
      ipcMain.removeHandler(channel);
  };
}
