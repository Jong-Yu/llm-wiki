import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AnalysisExecutionInspection } from '@contracts/analysis.contract';
import {
  buildAnalysisProgressView,
  documentTaskApi,
  DocumentTaskDetail,
  DocumentTaskDetailLoading,
} from '@renderer/features/browse-document-tasks';
import type {
  DocumentTaskAction,
  DocumentTaskView,
} from '@renderer/features/browse-document-tasks';
import { continueReviewedRegistration } from '@renderer/features/review-source-notifications';
import type { ImportScope } from '@renderer/features/import-document-content';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { invalidatesReadScope } from '@renderer/shared/lib/readQueries';

type RemoteDocumentProgressProps = { scope: ImportScope; jobId: string };

/** 다른 기기의 등록도 서버 영수증으로 읽고 명시 재개 직전에 실행 가능 상태를 다시 확인합니다. */
export function RemoteDocumentProgress({
  scope,
  jobId,
}: RemoteDocumentProgressProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [inspection, setInspection] =
    useState<AnalysisExecutionInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const acting = useRef(false);
  const load = useCallback(async (): Promise<void> => {
    if (pending.current || acting.current) return;
    pending.current = true;
    const request = ++generation.current;
    try {
      const result = await documentTaskApi.inspectAnalysis({
        connectionId: scope.connectionId,
        jobId,
      });
      if (request !== generation.current) return;
      if (!result.ok) {
        if (invalidatesReadScope(result.error)) setInspection(null);
        setError(result.error.message);
        return;
      }
      if (result.data.detail.job.job_id !== jobId) {
        setInspection(null);
        setError(
          '선택한 문서의 진행 기록과 응답이 일치하지 않습니다. 다시 확인해 주세요.',
        );
        return;
      }
      setInspection(result.data);
      setError(null);
    } catch {
      if (request === generation.current)
        setError('진행 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
    } finally {
      if (request === generation.current) pending.current = false;
    }
  }, [scope.connectionId, jobId]);
  useEffect((): (() => void) => {
    if (active)
      queueMicrotask((): void => {
        void load();
      });
    const timer = active
      ? window.setInterval((): void => {
          void load();
        }, 4000)
      : null;
    return (): void => {
      generation.current += 1;
      pending.current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [active, load]);
  /** 조회에서 실행으로 넘어가지 않으며 버튼을 누른 경우에만 최신 검사 판본을 사용합니다. */
  async function act(action: DocumentTaskAction): Promise<void> {
    if (busy || acting.current) return;
    if (action === 'refresh') {
      await load();
      return;
    }
    if (action !== 'execute' || !scope.canPrepare) return;
    acting.current = true;
    pending.current = false;
    const request = ++generation.current;
    setBusy(true);
    try {
      const result = await documentTaskApi.inspectAnalysis({
        connectionId: scope.connectionId,
        jobId,
      });
      if (request !== generation.current) return;
      if (!result.ok) {
        if (invalidatesReadScope(result.error)) setInspection(null);
        setError(result.error.message);
        return;
      }
      setInspection(result.data);
      if (
        !result.data.mode ||
        result.data.blockers.length > 0 ||
        result.data.detail.job.job_id !== jobId
      ) {
        setError(
          '현재 상태에서는 다시 시작할 수 없습니다. 저장 결과와 연결 상태를 확인해 주세요.',
        );
        return;
      }
      const reviewed = await continueReviewedRegistration(
        scope,
        result.data.detail.job,
        (): boolean => request === generation.current,
      );
      if (request !== generation.current) return;
      if (reviewed !== null) {
        if (!reviewed.ok) {
          if (invalidatesReadScope(reviewed.error)) setInspection(null);
          setError(reviewed.error.message);
        } else {
          const current = await documentTaskApi.readAnalysis({
            connectionId: scope.connectionId,
            jobId,
          });
          if (request !== generation.current) return;
          if (!current.ok) {
            if (invalidatesReadScope(current.error)) setInspection(null);
            setError(current.error.message);
          } else {
            setInspection({ ...result.data, detail: current.data, mode: null });
            setError(null);
          }
        }
        return;
      }
      const execution = await documentTaskApi.executeAnalysis({
        connectionId: scope.connectionId,
        jobId,
        expectedJobRevision: result.data.detail.job.job_revision,
        mode: result.data.mode,
      });
      if (request !== generation.current) return;
      if (!execution.ok) {
        if (invalidatesReadScope(execution.error)) setInspection(null);
        setError(execution.error.message);
      } else {
        setInspection({ ...result.data, detail: execution.data, mode: null });
        setError(null);
      }
    } catch {
      if (request === generation.current)
        setError(
          '요청 결과를 확인하지 못했습니다. 다시 시작하기 전에 결과를 확인해 주세요.',
        );
    } finally {
      acting.current = false;
      setBusy(false);
      if (request === generation.current) void load();
    }
  }
  if (!inspection)
    return (
      <DocumentTaskDetailLoading
        error={error}
        onRetry={(): void => {
          void load();
        }}
      />
    );
  const view = buildAnalysisProgressView(inspection.detail, scope.canPrepare);
  const task: DocumentTaskView =
    inspection.mode &&
    inspection.blockers.length === 0 &&
    scope.canPrepare &&
    !error
      ? {
          ...view,
          primaryAction: {
            id: 'execute',
            label:
              inspection.mode === 'resume'
                ? '중단된 단계 다시 시작'
                : '등록 계속',
          },
        }
      : view;
  return (
    <DocumentTaskDetail
      task={task}
      busy={busy}
      error={error}
      onAction={(action: DocumentTaskAction): void => {
        void act(action);
      }}
    />
  );
}
