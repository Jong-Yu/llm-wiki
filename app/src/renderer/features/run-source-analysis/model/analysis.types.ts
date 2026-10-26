import type {
  AnalysisStartRequest,
  AnalysisDetailResult,
  AnalysisPage,
} from '@contracts/analysis.contract';

/** 목록에서 선택한 원본과 당시의 조회 범위입니다. 토큰이나 로컬 파일 경로는 담지 않습니다. */
export type AnalysisSourceSelection = Omit<
  AnalysisStartRequest,
  'targetDocument' | 'outputs'
> & {
  title: string;
  scope: {
    userId: string;
    tenant: string;
    profileId: string;
    policyRevision: string;
  };
};
export type AnalysisError = Extract<
  AnalysisDetailResult,
  { ok: false }
>['error'];
export type AnalysisListState =
  | { status: 'loading' }
  | { status: 'ready'; page: AnalysisPage }
  | { status: 'error'; error: AnalysisError };
