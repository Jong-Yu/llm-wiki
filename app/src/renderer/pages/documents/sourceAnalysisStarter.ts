import {
  isSourceAnalysisInFlight,
  startSourceAnalysis,
} from '@renderer/features/import-document-content';
import type { SourceAnalysisStarter } from '@renderer/features/browse-document-library';

/** 목록·상세의 "분석 시작"을 등록 후 처리 흐름(변환→등록 작업→AI 추출)에 연결합니다. */
export const sourceAnalysisStarter: SourceAnalysisStarter = {
  start: startSourceAnalysis,
  inFlight: isSourceAnalysisInFlight,
};
