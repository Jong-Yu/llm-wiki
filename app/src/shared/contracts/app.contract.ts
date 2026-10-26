import type { RecoveryBridge } from './recovery.contract';
import type { ProposalExecutionBridge } from './proposalExecution.contract';
import type { RuntimeBridge } from './runtime.contract';
import type { SourceConversionBridge } from './sourceConversion.contract';
import type { AnalysisProposalsBridge } from './analysisProposals.contract';
import type { ResultDraftBridge } from './resultDrafts.contract';
import type { QuestionRunsBridge } from './questionRuns.contract';
import type { ConnectionBridge } from './connection.contract';
import type { DocumentsBridge } from './documents.contract';
import type { SourcesBridge } from './sources.contract';
import type { KnowledgeBridge } from './knowledge.contract';
import type { WorkspaceBridge } from './workspace.contract';
import type { AnalysisBridge } from './analysis.contract';
import type { ArtifactsBridge } from './artifacts.contract';

/** 공개 앱 정보와 제한된 연결 작업만 노출하는 IPC 계약입니다. */
export const IPC_CHANNELS = { appGetInfo: 'app:get-info' } as const;

export type GetAppInfoResponse = {
  name: string;
  version: string;
  electronVersion: string;
  platform: string;
};

export type GetAppInfoResult =
  | { ok: true; data: GetAppInfoResponse }
  | {
      ok: false;
      error: { code: 'forbidden' | 'invalid_request'; detail: string };
    };

export type WikiBridge = {
  runtime: RuntimeBridge;
  recovery?: RecoveryBridge;
  proposalExecution: ProposalExecutionBridge;
  app: { getInfo: () => Promise<GetAppInfoResult> };
  connection: ConnectionBridge;
  documents: DocumentsBridge;
  sources: SourcesBridge;
  knowledge: KnowledgeBridge;
  workspace: WorkspaceBridge;
  analysis: AnalysisBridge;
  artifacts: ArtifactsBridge;
  resultDrafts: ResultDraftBridge;
  questionRuns: QuestionRunsBridge;
  sourceConversion: SourceConversionBridge;
  analysisProposals: AnalysisProposalsBridge;
};

/** IPC 경계에서 외부 입력을 검사하며 타입 단언으로 응답을 신뢰하지 않습니다. */
export function parseGetAppInfoResult(value: unknown): GetAppInfoResult {
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    if (value.ok === true && 'data' in value) {
      const data = value.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        'name' in data &&
        typeof data.name === 'string' &&
        'version' in data &&
        typeof data.version === 'string' &&
        'electronVersion' in data &&
        typeof data.electronVersion === 'string' &&
        'platform' in data &&
        typeof data.platform === 'string'
      ) {
        return {
          ok: true,
          data: {
            name: data.name,
            version: data.version,
            electronVersion: data.electronVersion,
            platform: data.platform,
          },
        };
      }
    }
    if (value.ok === false && 'error' in value) {
      const error = value.error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'forbidden' || error.code === 'invalid_request') &&
        'detail' in error &&
        typeof error.detail === 'string'
      ) {
        return { ok: false, error: { code: error.code, detail: error.detail } };
      }
    }
  }
  throw new Error('앱 정보 응답을 확인할 수 없습니다.');
}
