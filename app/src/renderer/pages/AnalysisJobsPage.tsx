import { RunAnalysisJob } from '@renderer/features/run-source-analysis';
import type { AnalysisExecutionScope } from '@contracts/analysis.contract';
import { PageNavigation } from '@renderer/shared/ui/PageNavigation';
import { useState } from 'react';
import type { JSX } from 'react';
import type { AnalysisJob } from '@contracts/analysis.contract';
import { AnalysisJobs } from '@renderer/features/list-analysis-jobs';
import { ViewExtraction } from '@renderer/features/view-extraction';
import type { ExtractionScope } from '@renderer/features/view-extraction';

/** 실제 API 작업 목록 feature를 앱 경로에 조립합니다. */
export function AnalysisJobsPage(): JSX.Element {
  const [selection, setSelection] = useState<{
    job: AnalysisJob;
    scope: ExtractionScope;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  const [running, setRunning] = useState<{
    jobId: string;
    scope: AnalysisExecutionScope;
  } | null>(null);
  /** 작업 목록이 실제 읽은 이벤트와 범위를 추출 조회 feature에 전달합니다. */
  function viewExtraction(job: AnalysisJob, scope: ExtractionScope): void {
    setSelection({ job, scope });
  }
  /** 추출 창만 닫으며 기존 작업 3분할의 선택을 유지합니다. */
  function close(): void {
    setSelection(null);
  }
  /** 허용 범위 변경 시 예전 결과를 숨기고 현재 작업 목록을 다시 확인합니다. */
  function scopeInvalidated(): void {
    setSelection(null);
    setGeneration((value: number): number => value + 1);
  }
  return (
    <>
      <AnalysisJobs
        navigation={
          <PageNavigation
            links={[
              { to: '/conversations', label: '질문·대화' },
              { to: '/saved-results', label: '결과물' },
              { to: '/analysis-plan', label: '분석 범위·산출물' },
            ]}
          />
        }
        key={generation}
        onViewExtraction={viewExtraction}
        onRunJob={(jobId: string, scope: AnalysisExecutionScope): void =>
          setRunning({ jobId, scope })
        }
      />
      {running && (
        <RunAnalysisJob
          jobId={running.jobId}
          scope={running.scope}
          onClose={(): void => setRunning(null)}
        />
      )}
      {selection && (
        <ViewExtraction
          key={JSON.stringify([selection.scope, selection.job.job_id])}
          job={selection.job}
          scope={selection.scope}
          onClose={close}
          onScopeInvalidated={scopeInvalidated}
        />
      )}
    </>
  );
}
