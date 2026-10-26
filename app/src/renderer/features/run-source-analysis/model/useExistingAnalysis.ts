import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalysisDetailResult,
  AnalysisExecutionInspection,
  AnalysisExecutionInspectionResult,
  AnalysisExecutionScope,
} from '@contracts/analysis.contract';
import {
  executeExistingAnalysis,
  inspectExistingAnalysis,
  stopExistingAnalysis,
} from '../api/existingAnalysis.api';
import type { AnalysisError } from './analysis.types';

export type ExistingAnalysisModel = {
  inspection: AnalysisExecutionInspection | null;
  error: AnalysisError | null;
  busy: boolean;
  invalid: boolean;
  refresh: () => void;
  execute: () => void;
  stop: () => void;
};
/** 명시 확인과 실행을 분리하고 늦은 응답·중복 클릭·자동 재개를 막습니다. */
export function useExistingAnalysis(
  scope: AnalysisExecutionScope,
  jobId: string,
): ExistingAnalysisModel {
  const [inspection, setInspection] =
    useState<AnalysisExecutionInspection | null>(null);
  const [error, setError] = useState<AnalysisError | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const action = useRef(false);
  const { connectionId, userId, tenant, profileId, policyRevision } = scope;
  const currentScope = useMemo(
    (): AnalysisExecutionScope => ({
      connectionId,
      userId,
      tenant,
      profileId,
      policyRevision,
    }),
    [connectionId, userId, tenant, profileId, policyRevision],
  );

  /** 실패 뒤 확인한 실행 버튼을 무효화하고 권한이 허용하는 기존 결과를 보존합니다. */
  const fail = useCallback((value: AnalysisError): void => {
    setError(value);
    if (
      value.status === 401 ||
      value.status === 403 ||
      ['scope_changed', 'connection_changed', 'access_changed'].includes(
        value.code,
      )
    ) {
      setInvalid(true);
      setInspection(null);
    } else
      setInspection(
        (
          previous: AnalysisExecutionInspection | null,
        ): AnalysisExecutionInspection | null =>
          previous ? { ...previous, mode: null } : null,
      );
  }, []);
  /** 최신 응답만 채택하고 조회만으로 분석을 시작하지 않습니다. */
  const apply = useCallback(
    (result: AnalysisExecutionInspectionResult, request: number): void => {
      if (!mounted.current || generation.current !== request) return;
      setBusy(false);
      if (!result.ok) {
        fail(result.error);
        return;
      }
      if (
        result.data.detail.job.job_id !== jobId ||
        result.data.detail.job.tenant !== currentScope.tenant ||
        result.data.detail.job.user_id !== currentScope.userId
      ) {
        fail({
          code: 'scope_changed',
          message:
            '선택 작업과 응답 범위가 일치하지 않습니다. 현재 선택에서 다시 열어 주세요.',
        });
        return;
      }
      setInspection(result.data);
      setError(null);
    },
    [currentScope.tenant, currentScope.userId, fail, jobId],
  );
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    void inspectExistingAnalysis(currentScope, jobId).then(
      (result: AnalysisExecutionInspectionResult): void =>
        apply(result, request),
    );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [apply, currentScope, jobId]);
  useEffect((): (() => void) | undefined => {
    if (
      inspection?.detail.local.status !== 'running' ||
      busy ||
      error ||
      invalid
    )
      return undefined;
    const timer = setTimeout((): void => {
      const request = ++generation.current;
      void inspectExistingAnalysis(currentScope, jobId).then(
        (result: AnalysisExecutionInspectionResult): void =>
          apply(result, request),
      );
    }, 2000);
    return (): void => clearTimeout(timer);
  }, [inspection, busy, error, invalid, currentScope, jobId, apply]);
  /** 사용자의 새로고침은 새 판본을 확인하는 읽기 동작입니다. */
  function refresh(): void {
    if (action.current || invalid) return;
    setBusy(true);
    setError(null);
    const request = ++generation.current;
    void inspectExistingAnalysis(currentScope, jobId).then(
      (result: AnalysisExecutionInspectionResult): void =>
        apply(result, request),
    );
  }
  /** 실행 응답은 저장 성공과 구분하며 이전 확인을 소모한 후 다시 조회합니다. */
  async function perform(stop: boolean): Promise<void> {
    if (
      action.current ||
      busy ||
      invalid ||
      !inspection ||
      (!stop && (!inspection.mode || error))
    )
      return;
    action.current = true;
    setBusy(true);
    setError(null);
    const request = ++generation.current;
    const mode = inspection.mode;
    setInspection({ ...inspection, mode: null });
    const result: AnalysisDetailResult = stop
      ? await stopExistingAnalysis(currentScope, jobId)
      : await executeExistingAnalysis(currentScope, {
          jobId,
          expectedJobRevision: inspection.detail.job.job_revision,
          mode: mode === 'resume' ? 'resume' : 'start',
        });
    action.current = false;
    if (!mounted.current || generation.current !== request) return;
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setInspection({
      ...inspection,
      detail: result.data,
      mode: null,
      blockers: ['최신 실행·저장 상태를 확인해 주세요.'],
    });
    setBusy(true);
    const followup = ++generation.current;
    apply(await inspectExistingAnalysis(currentScope, jobId), followup);
  }
  /** 명시 실행만 개인 CLI를 시작합니다. */
  function execute(): void {
    void perform(false);
  }
  /** 이 앱에서 실행 중인 프로세스만 멈춥니다. */
  function stop(): void {
    void perform(true);
  }
  return { inspection, error, busy, invalid, refresh, execute, stop };
}
