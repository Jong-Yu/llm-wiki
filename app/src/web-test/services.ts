import { KnowledgeComparisonService } from '@main/backend/KnowledgeComparisonService';
import type { ComparisonRuntime } from '@main/backend/KnowledgeComparisonService';
import {
  KNOWLEDGE_COMPARISON_CHANNELS,
  knowledgeComparisonListSchema,
  knowledgeComparisonReadSchema,
  knowledgeComparisonRestartSchema,
} from '@contracts/knowledgeComparisons.contract';
import { AiSessionsService } from '@main/backend/AiSessionsService';
import {
  AI_SESSIONS_CHANNELS,
  aiSessionsRequestSchema,
} from '@contracts/aiSessions.contract';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@contracts/app.contract';
import {
  CONNECTION_CHANNELS,
  parseAccountRequest,
  parseConnectRequest,
  parseSelectWorkspaceRequest,
} from '@contracts/connection.contract';
import {
  DOCUMENT_CHANNELS,
  parseDocumentListRequest,
  parseDocumentContentRequest,
  parseSourcePreviewRequest,
} from '@contracts/documents.contract';
import {
  SOURCE_CHANNELS,
  sourceSessionSchema,
  sourceReceiptRequestSchema,
  sourceRegistrationRequestSchema,
  sourceVersionsRequestSchema,
} from '@contracts/sources.contract';
import {
  KNOWLEDGE_CHANNELS,
  parseDocumentKnowledgeRequest,
} from '@contracts/knowledge.contract';
import {
  WORKSPACE_CHANNELS,
  parseWorkspaceRequest,
} from '@contracts/workspace.contract';
import {
  ARTIFACTS_CHANNELS,
  chooseArtifactFileRequestSchema,
  artifactUploadRequestSchema,
  artifactDownloadRequestSchema,
} from '@contracts/artifacts.contract';
import {
  ANALYSIS_CHANNELS,
  analysisListRequestSchema,
  analysisStartRequestSchema,
  analysisReadRequestSchema,
  analysisCancelRequestSchema,
  analysisExecuteRequestSchema,
} from '@contracts/analysis.contract';
import {
  QUESTION_RUN_CHANNELS,
  questionCreateSchema,
  questionCreationReceiptSchema,
  questionListSchema,
  questionReadSchema,
  questionStartSchema,
  questionCancelSchema,
  questionResumableSchema,
  questionSearchTermsSchema,
  questionWebSearchSchema,
} from '@contracts/questionRuns.contract';
import {
  ANALYSIS_PROPOSALS_CHANNELS,
  analysisProposalRequestSchema,
} from '@contracts/analysisProposals.contract';
import {
  PROPOSAL_EXECUTION_CHANNELS,
  proposalExecutionStartSchema,
  proposalExecutionReadSchema,
  proposalExecutionCancelSchema,
} from '@contracts/proposalExecution.contract';
import {
  RESULT_DRAFT_CHANNELS,
  resultDraftRequestSchema,
} from '@contracts/resultDrafts.contract';
import {
  RECOVERY_CHANNELS,
  recoveryRequestSchema,
} from '@contracts/recovery.contract';
import {
  SOURCE_CONVERSION_CHANNELS,
  sourceConversionStartSchema,
  sourceConversionReadSchema,
  sourceConversionCancelSchema,
} from '@contracts/sourceConversion.contract';
import {
  RUNTIME_CHANNELS,
  runtimeRequestSchema,
} from '@contracts/runtime.contract';
import type {
  RuntimeResult,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import type { ChooseSourceFileResult } from '@contracts/sources.contract';
import type { SourceFormat } from '@contracts/documents.contract';
import { AccountPreferencesStore } from '@main/backend/AccountPreferencesStore';
import { ConnectionService } from '@main/backend/ConnectionService';
import { WorkspaceApiService } from '@main/backend/WorkspaceApiService';
import { AnalysisService } from '@main/backend/AnalysisService';
import { QuestionRunService } from '@main/backend/QuestionRunService';
import type { QuestionRuntime } from '@main/backend/QuestionRunService';
import { AnalysisProposalsApi } from '@main/backend/AnalysisProposalsApi';
import { ProposalExecutionService } from '@main/backend/ProposalExecutionService';
import type { ProposalRuntime } from '@main/backend/ProposalExecutionService';
import { ResultDraftService } from '@main/backend/ResultDraftService';
import { SourceConversionService } from '@main/backend/SourceConversionService';
import {
  RecoveryService,
  logoutWithRecovery,
} from '@main/backend/RecoveryService';
import { RuntimeSettingsService } from '@main/settings/RuntimeSettingsService';
import { personalAi } from '@main/backend/personalAi';
import { WebMemoryRecoveryStore } from './servicesMemory';

type WebFailure = {
  ok: false;
  error: { code: string; message: string };
};
type Operation = (value: unknown) => unknown;
type Handler = { argumentCount: number; run: Operation };

export type WebServices = {
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
  uploadSource: (
    request: unknown,
    filename: string,
    bytes: Uint8Array,
  ) => Promise<ChooseSourceFileResult>;
  downloadSource: (request: unknown) => Promise<WebSourceDownload>;
  close: () => Promise<void>;
};
export type WebSourceDownload =
  | {
      ok: true;
      data: {
        bytes: Uint8Array;
        format: SourceFormat;
        sourceSha256: string;
        sizeBytes: number;
      };
    }
  | WebFailure;

/** 주소 별칭만 정규화하고 사용자 정보·검색 인자·다른 프로토콜은 거부합니다. */
export function canonicalServerUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_server');
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:api\/v1|mcp)$/, '');
  return url.href.replace(/\/+$/, '');
}

/** 내부 예외·파일 경로·원격 인증정보를 브라우저 응답에 넣지 않습니다. */
function failure(code: string, message: string): WebFailure {
  return { ok: false, error: { code, message } };
}

/** 브라우저에서 제공하지 않은 네이티브 동작을 성공으로 가장하지 않습니다. */
function unsupported(): WebFailure {
  return failure(
    'web_test_unsupported',
    '이 네이티브 작업은 웹 테스트에서 사용할 수 없습니다. 원본 파일 선택·내려받기는 화면의 파일 버튼을 사용해 주세요.',
  );
}

/** 기존 환경 서비스를 사용하되 웹 입력에서 로컬 경로나 로그인 창을 열지 않습니다. */
async function runtimeOperation(
  runtime: RuntimeSettingsService,
  value: unknown,
): Promise<RuntimeResult> {
  const request = runtimeRequestSchema.parse(value);
  if (request.operation === 'choose' || request.operation === 'connect-cli')
    return unsupported();
  if (request.operation === 'save')
    return failure(
      'web_test_unsupported',
      '웹 테스트의 AI 실행 환경은 시작할 때 설정합니다. WIKI_AI_PROVIDER 등 실행 설정을 지정해 다시 시작해 주세요.',
    );
  let data: RuntimeSnapshot;
  switch (request.operation) {
    case 'select-provider':
      data = runtime.selectProvider(request.provider);
      break;
    case 'select-model':
      data = await runtime.selectModel(request.provider, request.model);
      break;
    case 'diagnose':
      data = await runtime.diagnose();
      break;
    case 'discover-cli':
      data = await runtime.discoverCli();
      break;
    case 'check-cli-login':
      data = await runtime.checkCliLogin();
      break;
    case 'cancel-cli-login':
      data = runtime.cancelCliLogin();
      break;
    default:
      data = runtime.snapshot();
  }
  return { ok: true, data };
}

/** 실제 서버용 서비스를 조립하고 토큰은 프로세스 메모리에만 보관합니다. */
export async function createWebServices(
  temporaryRoot: string,
  projectRoot: string,
  allowedServerUrl: string,
): Promise<WebServices> {
  const allowedServer = canonicalServerUrl(allowedServerUrl);
  const runtime = new RuntimeSettingsService(
    join(temporaryRoot, 'runtime-settings'),
    projectRoot,
    async (): Promise<null> => null,
  );
  await runtime.initialize();
  const activeSettings = runtime.snapshot().settings;
  const connection = new ConnectionService(
    undefined,
    new AccountPreferencesStore(join(temporaryRoot, 'account-preferences')),
  );
  await connection.initialize();
  const memory = new WebMemoryRecoveryStore();
  const recovery = new RecoveryService(connection, memory);
  const workspace = new WorkspaceApiService(connection);
  const analysis = new AnalysisService(
    connection,
    recovery,
    join(temporaryRoot, 'analysis'),
  );
  const questions = new QuestionRunService(
    connection,
    async (): Promise<QuestionRuntime> => ({
      projectRoot: activeSettings.root,
      python: activeSettings.python,
      ai: await personalAi('question'),
      privateRoot: join(temporaryRoot, 'questions'),
      sessionRoot: join(temporaryRoot, 'question-sessions'),
    }),
    recovery,
  );
  const proposals = new AnalysisProposalsApi(connection);
  const proposalExecution = new ProposalExecutionService(
    connection,
    proposals,
    async (): Promise<ProposalRuntime> => ({
      projectRoot: activeSettings.root,
      python: activeSettings.python,
      ai: await personalAi('proposal'),
      privateRoot: join(temporaryRoot, 'proposals'),
    }),
    recovery,
  );
  const comparisons = new KnowledgeComparisonService(
    connection,
    recovery,
    async (): Promise<ComparisonRuntime> => ({
      projectRoot: activeSettings.root,
      python: activeSettings.python,
      ai: await personalAi('analysis'),
      privateRoot: join(temporaryRoot, 'comparisons'),
    }),
  );
  const sessions = new AiSessionsService(connection, [
    analysis,
    questions,
    proposalExecution,
    comparisons,
  ]);
  const drafts = new ResultDraftService(connection, recovery);
  const conversion = new SourceConversionService(
    connection,
    {
      workRoot: join(temporaryRoot, 'source-conversions'),
      projectRoot: activeSettings.root,
      python: activeSettings.python,
    },
    recovery,
  );
  const handlers = new Map<string, Handler>();
  let closed = false;

  /** 허용 작업만 정적으로 등록하며 서비스 객체의 임의 메서드를 찾지 않습니다. */
  function register(
    channel: string,
    argumentCount: number,
    run: Operation,
  ): void {
    handlers.set(channel, { argumentCount, run });
  }

  register(IPC_CHANNELS.appGetInfo, 0, (): unknown => ({
    ok: true,
    data: {
      name: 'LLM Wiki 웹 테스트',
      version: 'test',
      electronVersion: 'not-running',
      platform: process.platform,
    },
  }));
  register(
    CONNECTION_CHANNELS.authenticate,
    1,
    async (value: unknown): Promise<unknown> => {
      const request = parseAccountRequest(value);
      if (canonicalServerUrl(request.serverUrl) !== allowedServer)
        return failure(
          'forbidden_server',
          '시작할 때 지정한 테스트 서버 주소만 사용할 수 있습니다.',
        );
      return connection.authenticate(request);
    },
  );
  register(
    CONNECTION_CHANNELS.connect,
    1,
    async (value: unknown): Promise<unknown> => {
      const request = parseConnectRequest(value);
      if (canonicalServerUrl(request.serverUrl) !== allowedServer)
        return failure(
          'forbidden_server',
          '시작할 때 지정한 테스트 서버 주소만 사용할 수 있습니다.',
        );
      return connection.connect(request);
    },
  );
  register(CONNECTION_CHANNELS.getState, 0, (): unknown =>
    connection.getState(),
  );
  register(
    CONNECTION_CHANNELS.selectWorkspace,
    1,
    (value: unknown): Promise<unknown> =>
      connection.selectWorkspace(parseSelectWorkspaceRequest(value)),
  );
  register(CONNECTION_CHANNELS.disconnect, 0, (): Promise<unknown> =>
    logoutWithRecovery(connection, recovery),
  );
  register(CONNECTION_CHANNELS.restoreSaved, 0, (): Promise<unknown> =>
    connection.restoreSaved(),
  );
  register(CONNECTION_CHANNELS.forgetSaved, 0, (): Promise<unknown> =>
    connection.forgetSaved(),
  );
  register(DOCUMENT_CHANNELS.list, 1, (value: unknown): Promise<unknown> =>
    connection.listDocuments(parseDocumentListRequest(value)),
  );
  register(DOCUMENT_CHANNELS.content, 1, (value: unknown): Promise<unknown> =>
    connection.readDocumentContent(parseDocumentContentRequest(value)),
  );
  register(
    DOCUMENT_CHANNELS.sourcePreview,
    1,
    (value: unknown): Promise<unknown> =>
      connection.readSourcePreview(parseSourcePreviewRequest(value)),
  );
  register(SOURCE_CHANNELS.chooseFile, 1, (value: unknown): WebFailure => {
    sourceSessionSchema.parse(value);
    return unsupported();
  });
  register(SOURCE_CHANNELS.register, 1, (value: unknown): unknown => {
    const request = sourceRegistrationRequestSchema.parse(value);
    return connection.registerSource(request);
  });
  register(SOURCE_CHANNELS.receipt, 1, (value: unknown): Promise<unknown> =>
    connection.checkSourceRegistration(sourceReceiptRequestSchema.parse(value)),
  );
  register(SOURCE_CHANNELS.versions, 1, (value: unknown): Promise<unknown> =>
    connection.readSourceVersions(sourceVersionsRequestSchema.parse(value)),
  );
  register(SOURCE_CHANNELS.download, 1, (value: unknown): WebFailure => {
    parseSourcePreviewRequest(value);
    return unsupported();
  });
  register(KNOWLEDGE_CHANNELS.read, 1, (value: unknown): Promise<unknown> =>
    connection.readDocumentKnowledge(parseDocumentKnowledgeRequest(value)),
  );
  register(WORKSPACE_CHANNELS.execute, 1, (value: unknown): Promise<unknown> =>
    workspace.execute(parseWorkspaceRequest(value)),
  );
  register(ARTIFACTS_CHANNELS.chooseFile, 1, (value: unknown): WebFailure => {
    chooseArtifactFileRequestSchema.parse(value);
    return unsupported();
  });
  register(ARTIFACTS_CHANNELS.upload, 1, (value: unknown): WebFailure => {
    artifactUploadRequestSchema.parse(value);
    return unsupported();
  });
  register(ARTIFACTS_CHANNELS.download, 1, (value: unknown): WebFailure => {
    artifactDownloadRequestSchema.parse(value);
    return unsupported();
  });
  register(
    KNOWLEDGE_COMPARISON_CHANNELS.list,
    1,
    (value: unknown): Promise<unknown> =>
      comparisons.list(knowledgeComparisonListSchema.parse(value)),
  );
  register(
    KNOWLEDGE_COMPARISON_CHANNELS.read,
    1,
    (value: unknown): Promise<unknown> =>
      comparisons.read(knowledgeComparisonReadSchema.parse(value)),
  );
  register(
    KNOWLEDGE_COMPARISON_CHANNELS.restart,
    1,
    (value: unknown): Promise<unknown> =>
      comparisons.restart(knowledgeComparisonRestartSchema.parse(value)),
  );
  register(
    KNOWLEDGE_COMPARISON_CHANNELS.stopLocal,
    1,
    (value: unknown): Promise<unknown> =>
      comparisons.stopLocal(knowledgeComparisonReadSchema.parse(value)),
  );
  register(AI_SESSIONS_CHANNELS.read, 1, (value: unknown): Promise<unknown> =>
    sessions.read(aiSessionsRequestSchema.parse(value)),
  );
  register(ANALYSIS_CHANNELS.list, 1, (value: unknown): Promise<unknown> =>
    analysis.list(analysisListRequestSchema.parse(value)),
  );
  register(ANALYSIS_CHANNELS.start, 1, (value: unknown): Promise<unknown> =>
    analysis.start(analysisStartRequestSchema.parse(value)),
  );
  register(ANALYSIS_CHANNELS.read, 1, (value: unknown): Promise<unknown> =>
    analysis.read(analysisReadRequestSchema.parse(value)),
  );
  register(ANALYSIS_CHANNELS.cancel, 1, (value: unknown): Promise<unknown> =>
    analysis.cancel(analysisCancelRequestSchema.parse(value)),
  );
  register(
    ANALYSIS_CHANNELS.inspectExecution,
    1,
    (value: unknown): Promise<unknown> =>
      analysis.inspectExecution(analysisReadRequestSchema.parse(value)),
  );
  register(ANALYSIS_CHANNELS.execute, 1, (value: unknown): Promise<unknown> =>
    analysis.execute(analysisExecuteRequestSchema.parse(value)),
  );
  register(ANALYSIS_CHANNELS.stopLocal, 1, (value: unknown): Promise<unknown> =>
    analysis.stopLocal(analysisReadRequestSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.create,
    1,
    (value: unknown): Promise<unknown> =>
      questions.create(questionCreateSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.creationReceipt,
    1,
    (value: unknown): Promise<unknown> =>
      questions.creationReceipt(questionCreationReceiptSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.list, 1, (value: unknown): Promise<unknown> =>
    questions.list(questionListSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.read, 1, (value: unknown): Promise<unknown> =>
    questions.read(questionReadSchema.parse(value)),
  );
  register(QUESTION_RUN_CHANNELS.start, 1, (value: unknown): Promise<unknown> =>
    questions.start(questionStartSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.cancel,
    1,
    (value: unknown): Promise<unknown> =>
      questions.cancel(questionCancelSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.resumable,
    1,
    (value: unknown): Promise<unknown> =>
      questions.resumable(questionResumableSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.searchTerms,
    1,
    (value: unknown): Promise<unknown> =>
      questions.searchTerms(questionSearchTermsSchema.parse(value)),
  );
  register(
    QUESTION_RUN_CHANNELS.webSearch,
    1,
    (value: unknown): Promise<unknown> =>
      questions.webSearch(questionWebSearchSchema.parse(value)),
  );
  register(
    ANALYSIS_PROPOSALS_CHANNELS.execute,
    1,
    (value: unknown): Promise<unknown> =>
      proposals.execute(analysisProposalRequestSchema.parse(value)),
  );
  register(
    PROPOSAL_EXECUTION_CHANNELS.start,
    1,
    (value: unknown): Promise<unknown> =>
      proposalExecution.start(proposalExecutionStartSchema.parse(value)),
  );
  register(
    PROPOSAL_EXECUTION_CHANNELS.read,
    1,
    (value: unknown): Promise<unknown> =>
      proposalExecution.read(proposalExecutionReadSchema.parse(value)),
  );
  register(
    PROPOSAL_EXECUTION_CHANNELS.cancel,
    1,
    (value: unknown): Promise<unknown> =>
      proposalExecution.cancel(proposalExecutionCancelSchema.parse(value)),
  );
  register(
    RESULT_DRAFT_CHANNELS.execute,
    1,
    (value: unknown): Promise<unknown> =>
      drafts.execute(resultDraftRequestSchema.parse(value)),
  );
  register(RECOVERY_CHANNELS.execute, 1, (value: unknown): Promise<unknown> =>
    recovery.execute(recoveryRequestSchema.parse(value)),
  );
  register(
    SOURCE_CONVERSION_CHANNELS.start,
    1,
    (value: unknown): Promise<unknown> =>
      conversion.start(sourceConversionStartSchema.parse(value)),
  );
  register(
    SOURCE_CONVERSION_CHANNELS.read,
    1,
    (value: unknown): Promise<unknown> =>
      conversion.read(sourceConversionReadSchema.parse(value)),
  );
  register(
    SOURCE_CONVERSION_CHANNELS.cancel,
    1,
    (value: unknown): Promise<unknown> =>
      conversion.cancel(sourceConversionCancelSchema.parse(value)),
  );
  register(RUNTIME_CHANNELS.execute, 1, (value: unknown): Promise<unknown> =>
    runtimeOperation(runtime, value),
  );

  return {
    /** 파일 바이트는 기존 원본 서비스에서 권한·형식·용량을 검사한 뒤 선택 참조로 보관합니다. */
    uploadSource: async (
      value: unknown,
      filename: string,
      bytes: Uint8Array,
    ): Promise<ChooseSourceFileResult> => {
      if (closed)
        return failure('web_test_closed', '웹 테스트 서버가 종료되었습니다.');
      return connection.acceptSourceFile(
        sourceSessionSchema.parse(value),
        filename,
        bytes,
      );
    },
    /** 현재 권한·판본·해시 검증을 통과한 원본만 브라우저 다운로드로 내보냅니다. */
    downloadSource: async (value: unknown): Promise<WebSourceDownload> => {
      if (closed)
        return failure('web_test_closed', '웹 테스트 서버가 종료되었습니다.');
      return connection.readSourceDownload(parseSourcePreviewRequest(value));
    },
    /** HTTP 경계에서도 기존 IPC와 같은 인자 수와 업무 스키마를 확인합니다. */
    invoke: async (channel: string, args: unknown[]): Promise<unknown> => {
      if (closed)
        return failure('web_test_closed', '웹 테스트 서버가 종료되었습니다.');
      const handler = handlers.get(channel);
      if (
        !handler ||
        !Array.isArray(args) ||
        args.length !== handler.argumentCount
      )
        return failure(
          'invalid_request',
          '허용된 웹 테스트 요청과 인자 수를 확인해 주세요.',
        );
      try {
        return await handler.run(args[0]);
      } catch {
        return failure(
          'invalid_request',
          '요청의 입력 또는 실행 환경을 확인해 주세요. 기존 서버 자료는 자동으로 재전송하지 않았습니다.',
        );
      }
    },
    /** 작업 중단을 기다린 뒤 인증·초안 메모리를 비우며 서버 자료는 유지합니다. */
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      connection.disconnect();
      runtime.cancelCliLogin();
      await Promise.all([
        analysis.stop(),
        questions.stop(),
        conversion.stop(),
        proposalExecution.shutdown(),
        comparisons.shutdown(),
      ]);
      memory.clear();
    },
  };
}
