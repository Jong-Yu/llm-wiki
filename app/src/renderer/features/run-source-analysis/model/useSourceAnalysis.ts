import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnalysisDetail,
  AnalysisDetailResult,
  AnalysisJob,
  AnalysisPageResult,
  AnalysisStartRequest,
} from '@contracts/analysis.contract';
import {
  cancelSourceAnalysis,
  listSourceAnalysis,
  readSourceAnalysis,
  startSourceAnalysis,
} from '../api/sourceAnalysis.api';
import type {
  AnalysisError,
  AnalysisListState,
  AnalysisSourceSelection,
} from './analysis.types';

export type SourceAnalysisModel = {
  list: AnalysisListState;
  detail: AnalysisDetail | null;
  error: AnalysisError | null;
  busy: boolean;
  scopeInvalid: boolean;
  start: (
    targetDocument: string,
    outputs: AnalysisStartRequest['outputs'],
  ) => Promise<void>;
  select: (jobId: string) => void;
  refresh: () => void;
  next: () => void;
  cancel: () => void;
};

/** 저장 완료와 실행 종료를 함께 보고 상태를 계속 조회할지 판단합니다. */
function needsRefresh(detail: AnalysisDetail): boolean {
  if (detail.local.status === 'running') return true;
  return (
    detail.job.state !== 'cancelled' &&
    detail.job.lease_status === 'active' &&
    detail.job.result_summary.status !== 'complete' &&
    detail.job.result_summary.status !== 'pending_reconcile' &&
    detail.job.reported_status !== 'failed' &&
    detail.job.reported_status !== 'stopped'
  );
}

/** 열린 원본의 조회·실행을 관리합니다. 창을 다시 열어도 자동으로 AI를 실행하지 않습니다. */
export function useSourceAnalysis(
  source: AnalysisSourceSelection,
): SourceAnalysisModel {
  const [list, setList] = useState<AnalysisListState>({ status: 'loading' });
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [error, setError] = useState<AnalysisError | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [scopeInvalid, setScopeInvalid] = useState(false);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const listGeneration = useRef(0);
  const detailRef = useRef<AnalysisDetail | null>(null);
  const actionInFlight = useRef(false);

  /** 바뀐 접근 범위의 결과는 숨기고 새 원본 선택 전에는 쓰기 동작을 막습니다. */
  const applyError = useCallback((nextError: AnalysisError): void => {
    setError(nextError);
    if (
      [
        'scope_changed',
        'connection_changed',
        'subject_changed',
        'selection_required',
        'access_changed',
      ].includes(nextError.code) ||
      nextError.status === 401 ||
      nextError.status === 403
    ) {
      setScopeInvalid(true);
      detailRef.current = null;
      setDetail(null);
      setList({ status: 'error', error: nextError });
    }
  }, []);

  /** 마지막으로 선택한 작업의 응답만 받아 서버 결과를 화면에 옮깁니다. */
  const applyResult = useCallback(
    (result: AnalysisDetailResult, generation: number): void => {
      if (!mounted.current || generation !== requestGeneration.current) return;
      setReading(false);
      if (!result.ok) {
        applyError(result.error);
        return;
      }
      if (result.data.job.source_ref.source_id !== source.sourceId) {
        applyError({
          code: 'scope_changed',
          message:
            '선택한 원본과 작업의 원본이 다릅니다. 현재 자료에서 다시 열어 주세요.',
        });
        return;
      }
      detailRef.current = result.data;
      setDetail(result.data);
      // 상세에서 확인한 서버 상태를 목록에도 반영해 같은 작업의 표시가 서로 다르지 않게 합니다.
      setList((current: AnalysisListState): AnalysisListState => {
        if (current.status !== 'ready') return current;
        return {
          ...current,
          page: {
            ...current.page,
            items: current.page.items.map((job: AnalysisJob): AnalysisJob =>
              job.job_id === result.data.job.job_id ? result.data.job : job,
            ),
          },
        };
      });
      setError(null);
    },
    [applyError, source.sourceId],
  );

  /** 네트워크 조회가 끝난 뒤 현재 화면에 해당하는 페이지와 첫 작업만 반영합니다. */
  const applyPage = useCallback(
    async (
      result: AnalysisPageResult,
      generation: number,
      selectFirst: boolean,
    ): Promise<void> => {
      if (!mounted.current || generation !== listGeneration.current) return;
      if (!result.ok) {
        setList({ status: 'error', error: result.error });
        applyError(result.error);
        return;
      }
      setList({ status: 'ready', page: result.data });
      const first: AnalysisJob | undefined = result.data.items[0];
      if (selectFirst && first) {
        setReading(true);
        const request = ++requestGeneration.current;
        applyResult(await readSourceAnalysis(source, first.job_id), request);
      }
    },
    [source, applyError, applyResult],
  );

  /** 서버가 준 페이지 기준으로 목록을 읽고 오래된 응답을 버립니다. */
  async function fetchList(
    cursor: string | null,
    selectFirst: boolean,
  ): Promise<void> {
    const generation = ++listGeneration.current;
    await applyPage(
      await listSourceAnalysis(source, cursor),
      generation,
      selectFirst,
    );
  }

  /** 사용자 요청으로 목록을 바꿀 때만 즉시 진행 표시를 켭니다. */
  function loadList(cursor: string | null, selectFirst: boolean): void {
    setList({ status: 'loading' });
    void fetchList(cursor, selectFirst);
  }

  useEffect((): (() => void) => {
    mounted.current = true;
    // 초기에 과거 작업을 읽을 뿐 새 분석을 시작하지 않습니다.
    const generation = ++listGeneration.current;
    void listSourceAnalysis(source, null).then(
      (result: AnalysisPageResult): Promise<void> =>
        applyPage(result, generation, true),
    );
    return (): void => {
      mounted.current = false;
      requestGeneration.current += 1;
      listGeneration.current += 1;
    };
  }, [source, applyPage]);

  useEffect((): (() => void) | undefined => {
    if (!detail || !needsRefresh(detail) || error || busy || scopeInvalid)
      return undefined;
    const jobId = detail.job.job_id;
    const timer = setTimeout((): void => {
      const request = ++requestGeneration.current;
      void readSourceAnalysis(source, jobId).then(
        (result: AnalysisDetailResult): void => applyResult(result, request),
      );
    }, 2000);
    return (): void => clearTimeout(timer);
  }, [detail, error, busy, scopeInvalid, source, applyResult]);

  /** 제출 중 중복 클릭을 막고 입력을 한 번만 전송합니다. 실패 시 자동 재실행하지 않습니다. */
  async function start(
    targetDocument: string,
    outputs: AnalysisStartRequest['outputs'],
  ): Promise<void> {
    const current = detailRef.current;
    if (
      actionInFlight.current ||
      scopeInvalid ||
      reading ||
      error ||
      list.status !== 'ready' ||
      current?.job.result_summary.status === 'pending_reconcile' ||
      current?.receiptErrors.length ||
      current?.receipts.some(
        (receipt: AnalysisDetail['receipts'][number]): boolean =>
          receipt.saved === null,
      )
    )
      return;
    actionInFlight.current = true;
    setBusy(true);
    setError(null);
    const request = ++requestGeneration.current;
    const result = await startSourceAnalysis(source, targetDocument, outputs);
    applyResult(result, request);
    if (mounted.current) {
      setBusy(false);
      if (result.ok) loadList(null, false);
    }
    actionInFlight.current = false;
  }

  /** 기존 작업 선택은 조회만 수행하며 이전 상세를 새 작업의 결과로 표시하지 않습니다. */
  function select(jobId: string): void {
    if (busy || scopeInvalid) return;
    detailRef.current = null;
    setDetail(null);
    setReading(true);
    setError(null);
    const request = ++requestGeneration.current;
    void readSourceAnalysis(source, jobId).then(
      (result: AnalysisDetailResult): void => applyResult(result, request),
    );
  }

  /** 재조회는 저장을 반복하지 않습니다. 결과가 불명확하면 현재 상태부터 읽습니다. */
  function refresh(): void {
    if (busy || scopeInvalid) return;
    setError(null);
    const current = detailRef.current;
    if (current) select(current.job.job_id);
    loadList(null, current === null);
  }

  /** 서버가 다음 페이지 기준을 준 경우에만 이어서 읽습니다. */
  function next(): void {
    if (
      busy ||
      scopeInvalid ||
      list.status !== 'ready' ||
      !list.page.nextCursor
    )
      return;
    loadList(list.page.nextCursor, false);
  }

  /** 마지막으로 읽은 작업 판본으로 중단을 요청하며 저장된 결과는 지우지 않습니다. */
  function cancel(): void {
    const current = detailRef.current;
    if (!current || actionInFlight.current || scopeInvalid) return;
    actionInFlight.current = true;
    setBusy(true);
    setError(null);
    const request = ++requestGeneration.current;
    void cancelSourceAnalysis(
      source,
      current.job.job_id,
      current.job.job_revision,
    ).then((result: AnalysisDetailResult): void => {
      applyResult(result, request);
      actionInFlight.current = false;
      if (mounted.current) setBusy(false);
    });
  }

  return {
    list,
    detail,
    error,
    busy: busy || reading,
    scopeInvalid,
    start,
    select,
    refresh,
    next,
    cancel,
  };
}
