import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  ANALYSIS_PROPOSALS_CHANNELS,
  analysisProposalRequestSchema,
} from '@contracts/analysisProposals.contract';
import type { AnalysisProposalResult } from '@contracts/analysisProposals.contract';
import type { AnalysisProposalsApi } from '@main/backend/AnalysisProposalsApi';
import { isAppSender } from './isAppSender';

/** 기존 연결 서비스를 주입받아 허용 창·최상위 프레임·엄격한 입력만 처리합니다. */
export function registerAnalysisProposalHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: AnalysisProposalsApi,
): void {
  ipcMain.handle(
    ANALYSIS_PROPOSALS_CHANNELS.execute,
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<AnalysisProposalResult> => {
      if (!isAppSender(event, getWindow, rendererLocation))
        return {
          ok: false,
          error: { code: 'forbidden', message: '허용되지 않은 앱 요청입니다.' },
        };
      const parsed =
        args.length === 1
          ? analysisProposalRequestSchema.safeParse(args[0])
          : null;
      if (!parsed?.success)
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message: '추출안 요청을 확인해 주세요.',
          },
        };
      return service.execute(parsed.data);
    },
  );
}
