import { ProposalExecutionService } from '@main/backend/ProposalExecutionService';
import { registerProposalExecutionHandlers } from './registerProposalExecutionHandlers';
import { join } from 'node:path';
import { RecoveryService } from '@main/backend/RecoveryService';
import { ProtectedRecoveryStore } from '@main/backend/ProtectedRecoveryStore';
import { registerRecoveryHandlers } from './registerRecoveryHandlers';
import { QuestionRunService } from '@main/backend/QuestionRunService';
import { AnalysisProposalsApi } from '@main/backend/AnalysisProposalsApi';
import { registerQuestionRunHandlers } from './registerQuestionRunHandlers';
import { registerAnalysisProposalHandlers } from './registerAnalysisProposalHandlers';
import { registerSourceConversionHandlers } from './sourceConversionIpc';
import { app, ipcMain } from 'electron';
import {
  createConnectionProtection,
  createConnectionCipher,
} from '@main/backend/connectionProtection';
import { ResultDraftService } from '@main/backend/ResultDraftService';
import { registerAnalysisExecutionHandlers } from './registerAnalysisExecutionHandlers';
import { registerResultDraftHandlers } from './registerResultDraftHandlers';
import { AnalysisService } from '@main/backend/AnalysisService';
import { ArtifactService } from '@main/backend/ArtifactService';
import {
  ARTIFACTS_CHANNELS,
  chooseArtifactFileRequestSchema,
  artifactUploadRequestSchema,
  artifactDownloadRequestSchema,
} from '@contracts/artifacts.contract';
import type {
  ChooseArtifactFileResult,
  ArtifactUploadResult,
  ArtifactDownloadResult,
} from '@contracts/artifacts.contract';
import {
  ANALYSIS_CHANNELS,
  analysisListRequestSchema,
  analysisStartRequestSchema,
  analysisReadRequestSchema,
  analysisCancelRequestSchema,
} from '@contracts/analysis.contract';
import type {
  AnalysisDetailResult,
  AnalysisPageResult,
} from '@contracts/analysis.contract';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  CONNECTION_CHANNELS,
  parseConnectRequest,
  parseSelectWorkspaceRequest,
} from '@contracts/connection.contract';
import type { ConnectionResult } from '@contracts/connection.contract';
import {
  DOCUMENT_CHANNELS,
  parseDocumentContentRequest,
  parseDocumentListRequest,
  parseSourcePreviewRequest,
} from '@contracts/documents.contract';
import type {
  DocumentContentResult,
  DocumentListResult,
  SourcePreviewResult,
} from '@contracts/documents.contract';
import { ConnectionService } from '@main/backend/ConnectionService';
import { isAppSender } from './isAppSender';
import { WorkspaceApiService } from '@main/backend/WorkspaceApiService';
import {
  WORKSPACE_CHANNELS,
  parseWorkspaceRequest,
} from '@contracts/workspace.contract';
import type { WorkspaceResult } from '@contracts/workspace.contract';
import {
  KNOWLEDGE_CHANNELS,
  parseDocumentKnowledgeRequest,
} from '@contracts/knowledge.contract';
import type { DocumentKnowledgeResult } from '@contracts/knowledge.contract';
import {
  SOURCE_CHANNELS,
  sourceSessionSchema,
  sourceReceiptRequestSchema,
  sourceRegistrationRequestSchema,
  sourceVersionsRequestSchema,
} from '@contracts/sources.contract';
import type {
  ChooseSourceFileResult,
  SourceRegistrationResult,
  SourceVersionsResult,
  SourceDownloadResult,
} from '@contracts/sources.contract';

type HandlerResult =
  | ConnectionResult
  | DocumentListResult
  | DocumentContentResult
  | SourcePreviewResult
  | ChooseSourceFileResult
  | SourceRegistrationResult
  | SourceVersionsResult
  | SourceDownloadResult
  | DocumentKnowledgeResult
  | WorkspaceResult
  | ChooseArtifactFileResult
  | ArtifactUploadResult
  | ArtifactDownloadResult;
type AnalysisHandlerResult = AnalysisDetailResult | AnalysisPageResult;

/** 허용 창의 연결 의도만 받고 외부 입력 오류를 비밀 없는 결과로 변환합니다. */
export async function registerConnectionHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
): Promise<() => Promise<void>> {
  const service = new ConnectionService(
    createConnectionProtection(app.getPath('userData')),
  );
  // 앱 시작 때 한 번 복원하며 어떤 renderer 요청도 복원 완료 전에 받을 수 없습니다.
  await service.initialize();
  const recovery = new RecoveryService(
    service,
    new ProtectedRecoveryStore(
      join(app.getPath('userData'), 'work-recovery'),
      createConnectionCipher(),
    ),
  );
  registerRecoveryHandlers(getWindow, rendererLocation, recovery);
  const workspace = new WorkspaceApiService(service);
  const artifacts = new ArtifactService(service);
  const analysis = new AnalysisService(service, recovery);
  const questions = new QuestionRunService(service, undefined, recovery);
  registerQuestionRunHandlers(getWindow, rendererLocation, questions);
  const proposals = new AnalysisProposalsApi(service);
  const proposalExecution = new ProposalExecutionService(
    service,
    proposals,
    undefined,
    recovery,
  );
  registerAnalysisProposalHandlers(getWindow, rendererLocation, proposals);
  registerProposalExecutionHandlers(
    getWindow,
    rendererLocation,
    proposalExecution,
  );
  const stopConversions = registerSourceConversionHandlers(
    service,
    getWindow,
    rendererLocation,
    recovery,
  );
  registerAnalysisExecutionHandlers(getWindow, rendererLocation, analysis);
  registerResultDraftHandlers(
    getWindow,
    rendererLocation,
    new ResultDraftService(service, recovery),
  );
  /** 공통 호출자·인자 개수 검사 뒤에 작업별 입력 검사를 연결합니다. */
  const register = (
    channel: string,
    count: number,
    operation: (
      value: unknown,
    ) =>
      | HandlerResult
      | AnalysisHandlerResult
      | Promise<HandlerResult | AnalysisHandlerResult>,
  ): void => {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<HandlerResult | AnalysisHandlerResult> => {
        if (!isAppSender(event, getWindow, rendererLocation))
          return {
            ok: false,
            error: {
              code: 'forbidden',
              message: '허용되지 않은 앱 요청입니다.',
            },
          };
        if (args.length !== count)
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '앱 요청의 입력을 확인해 주세요.',
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: '앱 요청의 입력을 확인해 주세요.',
            },
          };
        }
      },
    );
  };
  register(
    CONNECTION_CHANNELS.connect,
    1,
    (value: unknown): Promise<ConnectionResult> =>
      service.connect(parseConnectRequest(value)),
  );
  register(CONNECTION_CHANNELS.getState, 0, (): ConnectionResult =>
    service.getState(),
  );
  register(
    CONNECTION_CHANNELS.selectWorkspace,
    1,
    (value: unknown): Promise<ConnectionResult> =>
      service.selectWorkspace(parseSelectWorkspaceRequest(value)),
  );
  register(
    CONNECTION_CHANNELS.disconnect,
    0,
    async (): Promise<ConnectionResult> => {
      const current = service.getState();
      if (
        current.ok &&
        current.data.status === 'connected' &&
        current.data.selection
      ) {
        const cleared = await recovery.forgetCurrent(current.data.connectionId);
        if (!cleared.ok)
          return {
            ok: false,
            error: {
              code: 'recovery_delete_failed',
              message: cleared.error.message,
            },
          };
      }
      return service.logout();
    },
  );
  register(CONNECTION_CHANNELS.restoreSaved, 0, (): Promise<ConnectionResult> =>
    service.restoreSaved(),
  );
  register(CONNECTION_CHANNELS.forgetSaved, 0, (): Promise<ConnectionResult> =>
    service.forgetSaved(),
  );
  register(
    DOCUMENT_CHANNELS.list,
    1,
    (value: unknown): Promise<DocumentListResult> =>
      service.listDocuments(parseDocumentListRequest(value)),
  );
  register(
    DOCUMENT_CHANNELS.content,
    1,
    (value: unknown): Promise<DocumentContentResult> =>
      service.readDocumentContent(parseDocumentContentRequest(value)),
  );
  register(
    DOCUMENT_CHANNELS.sourcePreview,
    1,
    (value: unknown): Promise<SourcePreviewResult> =>
      service.readSourcePreview(parseSourcePreviewRequest(value)),
  );
  register(
    SOURCE_CHANNELS.chooseFile,
    1,
    (
      value: unknown,
    ): Promise<ChooseSourceFileResult> | ChooseSourceFileResult => {
      const parent = getWindow();
      if (!parent)
        return {
          ok: false,
          error: {
            code: 'unavailable',
            message: '앱 창을 확인할 수 없습니다.',
          },
        };
      return service.chooseSourceFile(sourceSessionSchema.parse(value), parent);
    },
  );
  register(
    SOURCE_CHANNELS.register,
    1,
    (value: unknown): Promise<SourceRegistrationResult> =>
      service.registerSource(sourceRegistrationRequestSchema.parse(value)),
  );
  register(
    SOURCE_CHANNELS.receipt,
    1,
    (value: unknown): Promise<SourceRegistrationResult> =>
      service.checkSourceRegistration(sourceReceiptRequestSchema.parse(value)),
  );
  register(
    SOURCE_CHANNELS.versions,
    1,
    (value: unknown): Promise<SourceVersionsResult> =>
      service.readSourceVersions(sourceVersionsRequestSchema.parse(value)),
  );
  register(
    SOURCE_CHANNELS.download,
    1,
    (value: unknown): Promise<SourceDownloadResult> | SourceDownloadResult => {
      const parent = getWindow();
      if (!parent)
        return {
          ok: false,
          error: {
            code: 'unavailable',
            message: '앱 창을 확인할 수 없습니다.',
          },
        };
      return service.downloadSource(parseSourcePreviewRequest(value), parent);
    },
  );
  register(
    KNOWLEDGE_CHANNELS.read,
    1,
    (value: unknown): Promise<DocumentKnowledgeResult> =>
      service.readDocumentKnowledge(parseDocumentKnowledgeRequest(value)),
  );
  register(
    WORKSPACE_CHANNELS.execute,
    1,
    (value: unknown): Promise<WorkspaceResult> =>
      workspace.execute(parseWorkspaceRequest(value)),
  );
  register(
    ARTIFACTS_CHANNELS.chooseFile,
    1,
    (value: unknown): Promise<ChooseArtifactFileResult> =>
      artifacts.chooseFile(
        chooseArtifactFileRequestSchema.parse(value),
        getWindow() ?? undefined,
      ),
  );
  register(
    ARTIFACTS_CHANNELS.upload,
    1,
    (value: unknown): Promise<ArtifactUploadResult> =>
      artifacts.upload(artifactUploadRequestSchema.parse(value)),
  );
  register(
    ARTIFACTS_CHANNELS.download,
    1,
    (value: unknown): Promise<ArtifactDownloadResult> =>
      artifacts.download(
        artifactDownloadRequestSchema.parse(value),
        getWindow() ?? undefined,
      ),
  );
  register(
    ANALYSIS_CHANNELS.list,
    1,
    (value: unknown): Promise<AnalysisPageResult> =>
      analysis.list(analysisListRequestSchema.parse(value)),
  );
  register(
    ANALYSIS_CHANNELS.start,
    1,
    (value: unknown): Promise<AnalysisDetailResult> =>
      analysis.start(analysisStartRequestSchema.parse(value)),
  );
  register(
    ANALYSIS_CHANNELS.read,
    1,
    (value: unknown): Promise<AnalysisDetailResult> =>
      analysis.read(analysisReadRequestSchema.parse(value)),
  );
  register(
    ANALYSIS_CHANNELS.cancel,
    1,
    (value: unknown): Promise<AnalysisDetailResult> =>
      analysis.cancel(analysisCancelRequestSchema.parse(value)),
  );
  return async (): Promise<void> => {
    service.disconnect();
    await Promise.all([
      analysis.stop(),
      questions.stop(),
      stopConversions(),
      proposalExecution.shutdown(),
    ]);
  };
}
