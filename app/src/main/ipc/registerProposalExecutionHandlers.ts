import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ProposalExecutionService } from '@main/backend/ProposalExecutionService';
import {
  PROPOSAL_EXECUTION_CHANNELS,
  proposalExecutionStartSchema,
  proposalExecutionReadSchema,
  proposalExecutionCancelSchema,
} from '@contracts/proposalExecution.contract';
import type { ProposalExecutionResult } from '@contracts/proposalExecution.contract';
import { isAppSender } from './isAppSender';

/** 고정된 추출안 실행 채널과 허용된 최상위 앱 프레임만 연결합니다. */
export function registerProposalExecutionHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: ProposalExecutionService,
): () => void {
  /** 임의 셸·URL·추가 인자를 서비스로 넘기지 않습니다. */
  function register(
    channel: string,
    operation: (value: unknown) => Promise<ProposalExecutionResult>,
  ): void {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<ProposalExecutionResult> => {
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
              message: '추출안 실행 요청을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '추출안 실행 입력·환경을 확인해 주세요.',
            },
          };
        }
      },
    );
  }
  register(
    PROPOSAL_EXECUTION_CHANNELS.start,
    (value: unknown): Promise<ProposalExecutionResult> =>
      service.start(proposalExecutionStartSchema.parse(value)),
  );
  register(
    PROPOSAL_EXECUTION_CHANNELS.read,
    (value: unknown): Promise<ProposalExecutionResult> =>
      service.read(proposalExecutionReadSchema.parse(value)),
  );
  register(
    PROPOSAL_EXECUTION_CHANNELS.cancel,
    (value: unknown): Promise<ProposalExecutionResult> =>
      service.cancel(proposalExecutionCancelSchema.parse(value)),
  );
  return (): void => {
    for (const channel of Object.values(PROPOSAL_EXECUTION_CHANNELS))
      ipcMain.removeHandler(channel);
  };
}
