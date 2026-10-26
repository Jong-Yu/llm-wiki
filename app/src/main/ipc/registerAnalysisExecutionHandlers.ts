import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  ANALYSIS_CHANNELS,
  analysisReadRequestSchema,
  analysisExecuteRequestSchema,
} from '@contracts/analysis.contract';
import type {
  AnalysisDetailResult,
  AnalysisExecutionInspectionResult,
} from '@contracts/analysis.contract';
import type { AnalysisService } from '@main/backend/AnalysisService';
import { isAppSender } from './isAppSender';

type ExecutionResult = AnalysisDetailResult | AnalysisExecutionInspectionResult;

/** 기존 AnalysisService와 동일한 수명으로 조회·명시 실행·로컬 중단 채널만 추가합니다. */
export function registerAnalysisExecutionHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  analysis: AnalysisService,
): void {
  /** 허용 창·정확한 인자 수와 계약을 확인하고 내부 예외 원문을 공개하지 않습니다. */
  function register(
    channel: string,
    operation: (value: unknown) => Promise<ExecutionResult>,
  ): void {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<ExecutionResult> => {
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
              message: '실행 요청의 입력을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message:
                '실행 요청을 확인하지 못했습니다. 기존 작업 상태를 조회해 주세요.',
            },
          };
        }
      },
    );
  }
  register(
    ANALYSIS_CHANNELS.inspectExecution,
    (value: unknown): Promise<AnalysisExecutionInspectionResult> =>
      analysis.inspectExecution(analysisReadRequestSchema.parse(value)),
  );
  register(
    ANALYSIS_CHANNELS.execute,
    (value: unknown): Promise<AnalysisDetailResult> =>
      analysis.execute(analysisExecuteRequestSchema.parse(value)),
  );
  register(
    ANALYSIS_CHANNELS.stopLocal,
    (value: unknown): Promise<AnalysisDetailResult> =>
      analysis.stopLocal(analysisReadRequestSchema.parse(value)),
  );
}
