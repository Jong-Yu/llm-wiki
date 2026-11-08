import type {
  AnalysisStartRequest,
  AnalysisDetail,
  AnalysisDetailResult,
  AnalysisExecutionInspectionResult,
} from '@contracts/analysis.contract';
import type {
  SourceConversionRun,
  SourceConversionResult,
  SourceConversionScope,
  ConversionSource,
} from '@contracts/sourceConversion.contract';
import type { SourceRegistrationRecord } from '@contracts/sources.contract';
import type { WorkspaceRecovery } from '@contracts/workspace.contract';

export type ImportRegistration = Extract<
  SourceRegistrationRecord,
  { state: 'complete' }
>;
/** 처리 세션이 쓰는 등록 원본의 최소 입력입니다. 이미 등록된 원본도 같은 후처리를 재사용합니다. */
export type ImportRegisteredSource = Pick<
  ImportRegistration,
  'item' | 'cleanupWarningCount'
>;
export type ImportProcessingError = {
  code: string;
  message: string;
  status?: number;
  recovery?: WorkspaceRecovery;
  notSent?: boolean;
};
export type ImportProcessingResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ImportProcessingError };
/** 명시 등록 뒤 한 원본 판본의 처리 상태를 유지하며 실행 완료와 저장 완료를 분리합니다. */
export type ImportProcessingSnapshot = {
  busy: boolean;
  phase:
    | 'idle'
    | 'converting'
    | 'conversion_failed'
    | 'conversion_unconfirmed'
    | 'planning'
    | 'planning_unconfirmed'
    | 'ready'
    | 'running'
    | 'partial'
    | 'complete'
    | 'error';
  message: string;
  error: string | null;
  conversion: SourceConversionRun | null;
  detail: AnalysisDetail | null;
  canRetryConversion: boolean;
  canPrepare: boolean;
  canExecute: boolean;
  canRefresh: boolean;
  scopeInvalid: boolean;
  document: string | null;
  cleanupWarningCount: number;
};

/** 테스트는 이 제한된 동작 계약만 주입하며 제품에서는 기존 gateway 구현을 사용합니다. */
export type ImportProcessingApi = {
  conversionRead: (
    scope: SourceConversionScope,
    source: ConversionSource,
  ) => Promise<SourceConversionResult>;
  conversionStart: (
    scope: SourceConversionScope,
    source: ConversionSource,
  ) => Promise<SourceConversionResult>;
  register: (
    scope: SourceConversionScope,
    request: AnalysisStartRequest,
  ) => Promise<AnalysisDetailResult>;
  inspectJob: (
    scope: SourceConversionScope,
    jobId: string,
  ) => Promise<AnalysisExecutionInspectionResult>;
  executeJob: (
    scope: SourceConversionScope,
    jobId: string,
    revision: string,
    mode: 'start' | 'resume',
  ) => Promise<AnalysisDetailResult>;
};
