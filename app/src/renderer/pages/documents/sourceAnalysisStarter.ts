import {
  isSourceAnalysisInFlight,
  sourceAnalysisProgressPath,
  startSourceAnalysis,
  listSourceProcessingSessions,
} from '@renderer/features/import-document-content';
import type {
  SourceAnalysisStarter,
  LibrarySourceItem,
  LibraryScope,
} from '@renderer/features/browse-document-library';

/** 목록·상세의 "분석 시작"을 등록 후 처리 흐름(변환→등록 작업→AI 추출)에 연결합니다. */
export const sourceAnalysisStarter: SourceAnalysisStarter = {
  status: (
    item: LibrarySourceItem,
    scope: LibraryScope,
  ): ReturnType<NonNullable<SourceAnalysisStarter['status']>> => {
    const session = listSourceProcessingSessions(scope).find(
      (
        entry: ReturnType<typeof listSourceProcessingSessions>[number],
      ): boolean =>
        entry.registered.item.sourceId === item.sourceId &&
        entry.registered.item.sourceVersion === item.sourceVersion,
    );
    const value = session?.session.getSnapshot();
    if (!value || value.scopeInvalid) return null;
    if (value.phase === 'complete')
      return { kind: 'complete', label: '등록 완료' };
    if (value.phase === 'converting')
      return { kind: 'running', label: '문자 변환 중' };
    if (value.phase === 'conversion_review')
      return { kind: 'attention', label: '내용 확인 필요' };
    if (value.phase.includes('unconfirmed'))
      return { kind: 'attention', label: '저장 확인 필요' };
    if (value.phase === 'conversion_failed')
      return { kind: 'attention', label: '문자 변환 중단' };
    const ontology =
      value.detail?.job.active_input_ref?.stage === 'extract_ontology';
    if (value.phase === 'running')
      return {
        kind: 'running',
        label: ontology ? '온톨로지 구성 중' : 'Wiki 생성 중',
      };
    if (
      value.phase === 'planning' ||
      value.phase === 'ready' ||
      value.phase === 'idle'
    )
      return { kind: 'pending', label: 'Wiki 생성 대기' };
    return {
      kind: 'attention',
      label: ontology ? '온톨로지 중단' : 'Wiki 생성 중단',
    };
  },
  start: startSourceAnalysis,
  inFlight: isSourceAnalysisInFlight,
  progressPath: sourceAnalysisProgressPath,
};
