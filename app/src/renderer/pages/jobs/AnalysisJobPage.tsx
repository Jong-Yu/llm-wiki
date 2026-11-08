import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { AnalysisJobWorkspace } from '@renderer/features/browse-ai-sessions';

/** 주소에 고정된 분석 작업만 조회합니다. */
export function AnalysisJobPage(): JSX.Element {
  const [search] = useSearchParams();
  return <AnalysisJobWorkspace jobId={search.get('jobId')} />;
}
