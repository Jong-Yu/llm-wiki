import { useState } from 'react';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { PlanAnalysis } from '@renderer/features/plan-analysis';
import type { PlanConversionSlotProps } from '@renderer/features/plan-analysis';
import { RunAnalysisJob } from '@renderer/features/run-source-analysis';
import { ConvertSource } from '@renderer/features/convert-source';
import type { SourceConversionReference } from '@contracts/sourceConversion.contract';
import type { AnalysisExecutionScope } from '@contracts/analysis.contract';

/** 고정 원본 판본과 계획이 만든 기존 작업 ID를 각 기능의 공개 입력으로 연결합니다. */
export function AnalysisPlanPage(): JSX.Element {
  const [params] = useSearchParams();
  const sourceId = params.get('sourceId');
  const sourceVersion = params.get('sourceVersion');
  const document = params.get('document');
  const [running, setRunning] = useState<{
    jobId: string;
    scope: AnalysisExecutionScope;
  } | null>(null);
  return (
    <>
      <PlanAnalysis
        key={JSON.stringify([sourceId, sourceVersion, document])}
        sourceId={sourceId || undefined}
        sourceVersion={sourceVersion || undefined}
        document={document || undefined}
        onRunJob={(jobId: string, scope: AnalysisExecutionScope): void =>
          setRunning({ jobId, scope })
        }
        renderConversion={(context: PlanConversionSlotProps): JSX.Element => (
          <ConvertSource
            source={{
              sourceId: context.source.sourceId,
              sourceVersion: context.source.sourceVersion,
              sourceSha256: context.source.sourceSha256,
              registrationRevision: context.source.registrationRevision,
            }}
            scope={context.scope}
            allowed={context.canConvert}
            onScopeInvalidated={(): void => {
              setRunning(null);
              context.onScopeInvalidated();
            }}
            onConverted={(reference: SourceConversionReference): void =>
              context.onReportSaved(reference.conversionId)
            }
          />
        )}
      />
      {running && (
        <RunAnalysisJob
          jobId={running.jobId}
          scope={running.scope}
          onClose={(): void => setRunning(null)}
        />
      )}
    </>
  );
}
