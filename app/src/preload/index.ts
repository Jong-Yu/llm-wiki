import {
  RECOVERY_CHANNELS,
  parseRecoveryResult,
} from '@contracts/recovery.contract';
import type {
  RecoveryRequest,
  RecoveryResult,
} from '@contracts/recovery.contract';
import {
  PROPOSAL_EXECUTION_CHANNELS,
  parseProposalExecutionResult,
} from '@contracts/proposalExecution.contract';
import type {
  ProposalExecutionStart,
  ProposalExecutionRead,
  ProposalExecutionCancel,
  ProposalExecutionResult,
} from '@contracts/proposalExecution.contract';
import {
  RUNTIME_CHANNELS,
  parseRuntimeResult,
} from '@contracts/runtime.contract';
import type {
  RuntimeRequest,
  RuntimeResult,
} from '@contracts/runtime.contract';
import {
  ANALYSIS_PROPOSALS_CHANNELS,
  parseAnalysisProposalResult,
} from '@contracts/analysisProposals.contract';
import type {
  AnalysisProposalRequest,
  AnalysisProposalResult,
} from '@contracts/analysisProposals.contract';
import {
  QUESTION_RUN_CHANNELS,
  parseQuestionDetailResult,
  parseQuestionPageResult,
} from '@contracts/questionRuns.contract';
import type {
  QuestionCreateRequest,
  QuestionCreationReceiptRequest,
  QuestionListRequest,
  QuestionReadRequest,
  QuestionStartRequest,
  QuestionCancelRequest,
  QuestionDetailResult,
  QuestionPageResult,
} from '@contracts/questionRuns.contract';
import {
  SOURCE_CONVERSION_CHANNELS,
  parseSourceConversionResult,
} from '@contracts/sourceConversion.contract';
import type {
  SourceConversionStartRequest,
  SourceConversionReadRequest,
  SourceConversionCancelRequest,
  SourceConversionResult,
} from '@contracts/sourceConversion.contract';
import { contextBridge, ipcRenderer } from 'electron';
import {
  RESULT_DRAFT_CHANNELS,
  parseResultDraftResult,
} from '@contracts/resultDrafts.contract';
import type {
  ResultDraftRequest,
  ResultDraftResult,
} from '@contracts/resultDrafts.contract';
import {
  ARTIFACTS_CHANNELS,
  parseChooseArtifactFileResult,
  parseArtifactUploadResult,
  parseArtifactDownloadResult,
} from '@contracts/artifacts.contract';
import type {
  ChooseArtifactFileRequest,
  ChooseArtifactFileResult,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactDownloadRequest,
  ArtifactDownloadResult,
} from '@contracts/artifacts.contract';
import {
  KNOWLEDGE_CHANNELS,
  parseDocumentKnowledgeResult,
} from '@contracts/knowledge.contract';
import type {
  DocumentKnowledgeRequest,
  DocumentKnowledgeResult,
} from '@contracts/knowledge.contract';
import {
  WORKSPACE_CHANNELS,
  parseWorkspaceResult,
} from '@contracts/workspace.contract';
import type {
  WorkspaceRequest,
  WorkspaceResult,
} from '@contracts/workspace.contract';
import {
  ANALYSIS_CHANNELS,
  parseAnalysisDetailResult,
  parseAnalysisExecutionInspectionResult,
  parseAnalysisPageResult,
} from '@contracts/analysis.contract';
import type {
  AnalysisCancelRequest,
  AnalysisExecuteRequest,
  AnalysisExecutionInspectionResult,
  AnalysisDetailResult,
  AnalysisListRequest,
  AnalysisPageResult,
  AnalysisReadRequest,
  AnalysisStartRequest,
} from '@contracts/analysis.contract';
import {
  SOURCE_CHANNELS,
  parseChooseSourceFileResult,
  parseSourceRegistrationResult,
  parseSourceVersionsResult,
  parseSourceDownloadResult,
} from '@contracts/sources.contract';
import type {
  SourcesBridge,
  SourceSessionRequest,
  SourceRegistrationRequest,
  SourceReceiptRequest,
  ChooseSourceFileResult,
  SourceRegistrationResult,
  SourceVersionsRequest,
  SourceVersionsResult,
  SourceDownloadRequest,
  SourceDownloadResult,
} from '@contracts/sources.contract';
import { IPC_CHANNELS, parseGetAppInfoResult } from '@contracts/app.contract';
import type { GetAppInfoResult, WikiBridge } from '@contracts/app.contract';
import type {
  ConnectRequest,
  ConnectionResult,
  SelectWorkspaceRequest,
} from '@contracts/connection.contract';
import {
  CONNECTION_CHANNELS,
  parseConnectionResult,
} from '@contracts/connection.contract';
import {
  DOCUMENT_CHANNELS,
  parseDocumentContentResult,
  parseDocumentListResult,
  parseSourcePreviewResult,
} from '@contracts/documents.contract';
import type {
  DocumentContentRequest,
  DocumentContentResult,
  DocumentListRequest,
  DocumentListResult,
  SourcePreviewRequest,
  SourcePreviewResult,
} from '@contracts/documents.contract';

// 범용 채널 호출이나 Node 객체를 노출하지 않고 단일 CJS 번들로 실행합니다.
const wiki: WikiBridge = {
  recovery: {
    /** 현재 인증 범위의 보호 복구 자료만 전달합니다. */
    execute: async (request: RecoveryRequest): Promise<RecoveryResult> =>
      parseRecoveryResult(
        await ipcRenderer.invoke(RECOVERY_CHANNELS.execute, request),
      ),
  },
  proposalExecution: {
    /** 명시한 현재 후보 기준으로 개인 재추출을 실행합니다. */
    start: async (
      request: ProposalExecutionStart,
    ): Promise<ProposalExecutionResult> =>
      parseProposalExecutionResult(
        await ipcRenderer.invoke(PROPOSAL_EXECUTION_CHANNELS.start, request),
      ),
    /** 기존 실행의 결과만 조회합니다. */
    read: async (
      request: ProposalExecutionRead,
    ): Promise<ProposalExecutionResult> =>
      parseProposalExecutionResult(
        await ipcRenderer.invoke(PROPOSAL_EXECUTION_CHANNELS.read, request),
      ),
    /** 지정한 실행만 중단합니다. */
    cancel: async (
      request: ProposalExecutionCancel,
    ): Promise<ProposalExecutionResult> =>
      parseProposalExecutionResult(
        await ipcRenderer.invoke(PROPOSAL_EXECUTION_CHANNELS.cancel, request),
      ),
  },
  runtime: {
    /** 한정된 환경 설정 요청만 전달합니다. */
    execute: async (request: RuntimeRequest): Promise<RuntimeResult> =>
      parseRuntimeResult(
        await ipcRenderer.invoke(RUNTIME_CHANNELS.execute, request),
      ),
  },
  analysisProposals: {
    /** 조회·전체 추출안 제출·검증·명시 적용을 한정된 채널로 전달합니다. */
    execute: async (
      request: AnalysisProposalRequest,
    ): Promise<AnalysisProposalResult> =>
      parseAnalysisProposalResult(
        await ipcRenderer.invoke(ANALYSIS_PROPOSALS_CHANNELS.execute, request),
      ),
  },
  questionRuns: {
    /** 저장한 질문의 고정 기준으로 실행 요청만 만듭니다. */
    create: async (
      request: QuestionCreateRequest,
    ): Promise<QuestionDetailResult> =>
      parseQuestionDetailResult(
        await ipcRenderer.invoke(QUESTION_RUN_CHANNELS.create, request),
      ),
    /** 요청 결과 미확인은 재전송하지 않고 영수증으로 확인합니다. */
    creationReceipt: async (
      request: QuestionCreationReceiptRequest,
    ): Promise<QuestionDetailResult> =>
      parseQuestionDetailResult(
        await ipcRenderer.invoke(
          QUESTION_RUN_CHANNELS.creationReceipt,
          request,
        ),
      ),
    /** 실행 이력을 읽기만 합니다. */
    list: async (request: QuestionListRequest): Promise<QuestionPageResult> =>
      parseQuestionPageResult(
        await ipcRenderer.invoke(QUESTION_RUN_CHANNELS.list, request),
      ),
    /** 진행 표시와 실제 저장 답변을 분리해 조회합니다. */
    read: async (request: QuestionReadRequest): Promise<QuestionDetailResult> =>
      parseQuestionDetailResult(
        await ipcRenderer.invoke(QUESTION_RUN_CHANNELS.read, request),
      ),
    /** 명시 동작에서만 개인 CLI를 시작합니다. */
    start: async (
      request: QuestionStartRequest,
    ): Promise<QuestionDetailResult> =>
      parseQuestionDetailResult(
        await ipcRenderer.invoke(QUESTION_RUN_CHANNELS.start, request),
      ),
    /** 현재 질문 실행의 취소 의도를 전달합니다. */
    cancel: async (
      request: QuestionCancelRequest,
    ): Promise<QuestionDetailResult> =>
      parseQuestionDetailResult(
        await ipcRenderer.invoke(QUESTION_RUN_CHANNELS.cancel, request),
      ),
  },
  sourceConversion: {
    /** 개인 변환을 명시 실행하고 원본 경로와 바이트는 공개하지 않습니다. */
    start: async (
      request: SourceConversionStartRequest,
    ): Promise<SourceConversionResult> =>
      parseSourceConversionResult(
        await ipcRenderer.invoke(SOURCE_CONVERSION_CHANNELS.start, request),
      ),
    /** 기존 변환과 저장 영수증만 읽습니다. */
    read: async (
      request: SourceConversionReadRequest,
    ): Promise<SourceConversionResult> =>
      parseSourceConversionResult(
        await ipcRenderer.invoke(SOURCE_CONVERSION_CHANNELS.read, request),
      ),
    /** 해당 변환 실행만 중단하고 저장된 보고는 유지합니다. */
    cancel: async (
      request: SourceConversionCancelRequest,
    ): Promise<SourceConversionResult> =>
      parseSourceConversionResult(
        await ipcRenderer.invoke(SOURCE_CONVERSION_CHANNELS.cancel, request),
      ),
  },
  resultDrafts: {
    /** 초안 편집과 명시 반영의 결과를 검증한 뒤 전달합니다. */
    execute: async (request: ResultDraftRequest): Promise<ResultDraftResult> =>
      parseResultDraftResult(
        await ipcRenderer.invoke(RESULT_DRAFT_CHANNELS.execute, request),
      ),
  },
  artifacts: {
    /** 파일 경로와 바이너리는 main에 두고 선택 결과만 받습니다. */
    chooseFile: async (
      request: ChooseArtifactFileRequest,
    ): Promise<ChooseArtifactFileResult> =>
      parseChooseArtifactFileResult(
        await ipcRenderer.invoke(ARTIFACTS_CHANNELS.chooseFile, request),
      ),
    /** 고정한 작업·추출 판본과 선택 파일을 한 번만 전송합니다. */
    upload: async (
      request: ArtifactUploadRequest,
    ): Promise<ArtifactUploadResult> =>
      parseArtifactUploadResult(
        await ipcRenderer.invoke(ARTIFACTS_CHANNELS.upload, request),
      ),
    /** 원본 바이트는 main에서 검사하고 사용자가 선택한 새 파일로 저장합니다. */
    download: async (
      request: ArtifactDownloadRequest,
    ): Promise<ArtifactDownloadResult> =>
      parseArtifactDownloadResult(
        await ipcRenderer.invoke(ARTIFACTS_CHANNELS.download, request),
      ),
  },
  knowledge: {
    /** 선택한 위키의 검증된 지식만 공개합니다. */
    read: async (
      request: DocumentKnowledgeRequest,
    ): Promise<DocumentKnowledgeResult> =>
      parseDocumentKnowledgeResult(
        await ipcRenderer.invoke(KNOWLEDGE_CHANNELS.read, request),
      ),
  },
  workspace: {
    /** 허용된 작업 이름과 입력만 전달하고 범용 HTTP 호출은 노출하지 않습니다. */
    execute: async (request: WorkspaceRequest): Promise<WorkspaceResult> =>
      parseWorkspaceResult(
        await ipcRenderer.invoke(WORKSPACE_CHANNELS.execute, request),
      ),
  },
  analysis: {
    /** 기존 작업의 최신 실행 기준을 조회하며 실행은 하지 않습니다. */
    inspectExecution: async (
      request: AnalysisReadRequest,
    ): Promise<AnalysisExecutionInspectionResult> =>
      parseAnalysisExecutionInspectionResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.inspectExecution, request),
      ),
    /** 사용자가 확인한 작업 판본으로만 실행 또는 재개합니다. */
    execute: async (
      request: AnalysisExecuteRequest,
    ): Promise<AnalysisDetailResult> =>
      parseAnalysisDetailResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.execute, request),
      ),
    /** 기존 저장 결과를 유지하고 소유 로컬 프로세스만 중단합니다. */
    stopLocal: async (
      request: AnalysisReadRequest,
    ): Promise<AnalysisDetailResult> =>
      parseAnalysisDetailResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.stopLocal, request),
      ),
    /** 작업 목록은 조회만 하며 새 분석을 시작하지 않습니다. */
    list: async (request: AnalysisListRequest): Promise<AnalysisPageResult> =>
      parseAnalysisPageResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.list, request),
      ),
    /** 사용자가 요청한 분석만 main의 제한된 실행기에 전달합니다. */
    start: async (
      request: AnalysisStartRequest,
    ): Promise<AnalysisDetailResult> =>
      parseAnalysisDetailResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.start, request),
      ),
    /** CLI 출력과 별도로 서버 저장 상태를 확인합니다. */
    read: async (request: AnalysisReadRequest): Promise<AnalysisDetailResult> =>
      parseAnalysisDetailResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.read, request),
      ),
    /** 저장된 결과를 지우지 않고 후속 실행만 중단합니다. */
    cancel: async (
      request: AnalysisCancelRequest,
    ): Promise<AnalysisDetailResult> =>
      parseAnalysisDetailResult(
        await ipcRenderer.invoke(ANALYSIS_CHANNELS.cancel, request),
      ),
  },
  sources: {
    /** 원본 저장 결과만 검증해 전달합니다. */
    download: async (
      request: SourceDownloadRequest,
    ): Promise<SourceDownloadResult> =>
      parseSourceDownloadResult(
        await ipcRenderer.invoke(SOURCE_CHANNELS.download, request),
      ),
    /** 현재 원본의 전체 불변 판본을 읽습니다. */
    versions: async (
      request: SourceVersionsRequest,
    ): Promise<SourceVersionsResult> =>
      parseSourceVersionsResult(
        await ipcRenderer.invoke(SOURCE_CHANNELS.versions, request),
      ),
    /** 파일 경로 대신 main이 발급한 선택 참조만 전달합니다. */
    chooseFile: async (
      request: SourceSessionRequest,
    ): Promise<ChooseSourceFileResult> =>
      parseChooseSourceFileResult(
        await ipcRenderer.invoke(SOURCE_CHANNELS.chooseFile, request),
      ),
    /** 원본 등록은 지정된 채널로 한 번만 전송하고 응답을 검사합니다. */
    register: async (
      request: SourceRegistrationRequest,
    ): Promise<SourceRegistrationResult> =>
      parseSourceRegistrationResult(
        await ipcRenderer.invoke(SOURCE_CHANNELS.register, request),
      ),
    /** 응답이 불확실할 때 원본을 다시 보내지 않고 본인 영수증을 조회합니다. */
    receipt: async (
      request: SourceReceiptRequest,
    ): Promise<SourceRegistrationResult> =>
      parseSourceRegistrationResult(
        await ipcRenderer.invoke(SOURCE_CHANNELS.receipt, request),
      ),
  } satisfies SourcesBridge,
  app: {
    /** 공개 앱 정보 응답을 검사한 뒤 renderer에 전달합니다. */
    getInfo: async (): Promise<GetAppInfoResult> => {
      const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.appGetInfo);
      return parseGetAppInfoResult(result);
    },
  },
  connection: {
    /** 사용자가 요청한 경우에만 저장 연결의 현재 권한을 다시 확인합니다. */
    restoreSaved: async (): Promise<ConnectionResult> =>
      parseConnectionResult(
        await ipcRenderer.invoke(CONNECTION_CHANNELS.restoreSaved),
      ),
    /** 활성 연결과 별도로 OS 보호 저장의 자격증명을 삭제합니다. */
    forgetSaved: async (): Promise<ConnectionResult> =>
      parseConnectionResult(
        await ipcRenderer.invoke(CONNECTION_CHANNELS.forgetSaved),
      ),
    /** 서버 연결 요청과 비밀 없는 응답만 지정된 채널로 전달합니다. */
    connect: async (request: ConnectRequest): Promise<ConnectionResult> =>
      parseConnectionResult(
        await ipcRenderer.invoke(CONNECTION_CHANNELS.connect, request),
      ),
    /** main에 보관된 현재 연결의 공개 상태를 조회합니다. */
    getState: async (): Promise<ConnectionResult> =>
      parseConnectionResult(
        await ipcRenderer.invoke(CONNECTION_CHANNELS.getState),
      ),
    /** 선택한 공간·관점의 서버 재확인 결과를 전달합니다. */
    selectWorkspace: async (
      request: SelectWorkspaceRequest,
    ): Promise<ConnectionResult> =>
      parseConnectionResult(
        await ipcRenderer.invoke(CONNECTION_CHANNELS.selectWorkspace, request),
      ),
    /** main의 토큰과 선택 상태를 해제합니다. */
    disconnect: async (): Promise<ConnectionResult> =>
      parseConnectionResult(
        await ipcRenderer.invoke(CONNECTION_CHANNELS.disconnect),
      ),
  },
  documents: {
    /** 현재 연결에서 선택한 범위의 목록만 검증된 응답으로 전달합니다. */
    list: async (request: DocumentListRequest): Promise<DocumentListResult> =>
      parseDocumentListResult(
        await ipcRenderer.invoke(DOCUMENT_CHANNELS.list, request),
      ),
    /** 현재 선택 범위의 본문을 검사하고 원문의 공백과 개행을 보존합니다. */
    content: async (
      request: DocumentContentRequest,
    ): Promise<DocumentContentResult> =>
      parseDocumentContentResult(
        await ipcRenderer.invoke(DOCUMENT_CHANNELS.content, request),
      ),
    /** 불변 원본의 검증된 텍스트만 renderer에 공개합니다. */
    sourcePreview: async (
      request: SourcePreviewRequest,
    ): Promise<SourcePreviewResult> =>
      parseSourcePreviewResult(
        await ipcRenderer.invoke(DOCUMENT_CHANNELS.sourcePreview, request),
      ),
  },
};

contextBridge.exposeInMainWorld('wiki', wiki);
