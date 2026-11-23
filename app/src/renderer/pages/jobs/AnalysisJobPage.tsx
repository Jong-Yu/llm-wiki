import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { AnalysisJobWorkspace } from '@renderer/features/browse-ai-sessions';
import { documentTaskApi } from '@renderer/features/browse-document-tasks';
import {
  importScopeKey,
  useImportScope,
} from '@renderer/features/import-document-content';
import type { ImportScope } from '@renderer/features/import-document-content';
import type {
  DocumentTask,
  DocumentTaskListResult,
} from '@contracts/documentTasks.contract';
import {
  documentTaskPath,
  workflowReturnTo,
} from '@renderer/shared/lib/workflowNavigation';

type JobDestinationProps = { scope: ImportScope; jobId: string | null };

/** 같은 기기의 문서 작업에 연결된 분석은 통합 상세 주소로 열고 과거 주소도 유지합니다. */
function JobDestination({ scope, jobId }: JobDestinationProps): JSX.Element {
  const [destination, setDestination] = useState<string | null | undefined>(
    undefined,
  );
  const location = useLocation();
  useEffect((): (() => void) => {
    let current = true;
    void documentTaskApi
      .list({
        connectionId: scope.connectionId,
        expectedScope: {
          userId: scope.userId,
          tenant: scope.tenant,
          profileId: scope.profileId,
          policyRevision: scope.policyRevision,
          ...(scope.accessRevision
            ? { accessRevision: scope.accessRevision }
            : {}),
        },
      })
      .then((result: DocumentTaskListResult): void => {
        if (current)
          setDestination(
            result.ok
              ? (result.data.items.find(
                  (task: DocumentTask): boolean =>
                    task.registration.jobId === jobId,
                )?.taskId ?? null)
              : null,
          );
      })
      .catch((): void => {
        if (current) setDestination(null);
      });
    return (): void => {
      current = false;
    };
  }, [scope, jobId]);
  if (destination === undefined)
    return <p role="status">연결된 작업을 확인하고 있습니다…</p>;
  return destination ? (
    <Navigate
      to={documentTaskPath(destination)}
      replace
      state={{
        workflowReturnTo: workflowReturnTo(location.state) ?? '/sessions',
      }}
    />
  ) : (
    <AnalysisJobWorkspace jobId={jobId} />
  );
}

/** 주소에 고정된 분석 작업만 조회합니다. */
export function AnalysisJobPage(): JSX.Element {
  const [search] = useSearchParams();
  const model = useImportScope();
  const jobId = search.get('jobId');
  if (model.state.status === 'loading')
    return <p role="status">작업 공간을 확인하고 있습니다…</p>;
  return model.state.status === 'ready' ? (
    <JobDestination
      key={`${importScopeKey(model.state.scope)}:${jobId ?? ''}`}
      scope={model.state.scope}
      jobId={jobId}
    />
  ) : (
    <AnalysisJobWorkspace jobId={jobId} />
  );
}
