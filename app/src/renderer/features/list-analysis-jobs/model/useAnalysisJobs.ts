import { useEffect, useRef, useState } from 'react';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import { loadJobsPage, loadJobDetail } from '../api/analysisJobs.api';
import type { JobsPageResult, JobsScope } from '../api/analysisJobs.api';

type PageState = { status: 'loading' } | JobsPageResult;
type DetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; detail: AnalysisDetail }
  | { status: 'error'; message: string };
export type AnalysisJobsModel = {
  page: PageState;
  detail: DetailState;
  selected: string | null;
  pageNumber: number;
  canPrevious: boolean;
  refresh: () => void;
  previous: () => void;
  next: () => void;
  select: (jobId: string) => void;
  refreshDetail: () => void;
  cancel: () => void;
};

/** 작업 조회·페이지 이력·선택 상세의 수명을 분리해 예전 응답이 선택을 덮어쓰지 않습니다. */
export function useAnalysisJobs(): AnalysisJobsModel {
  const [page, setPage] = useState<PageState>({ status: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ status: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const mounted = useRef(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const busy = useRef(false);

  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    void loadJobsPage(null).then((result: JobsPageResult): void => {
      if (mounted.current && request === generation.current) setPage(result);
    });
    return (): void => {
      mounted.current = false;
      generation.current += 1;
      detailGeneration.current += 1;
    };
  }, []);

  /** 페이지를 바꾸면 이전 상세를 즉시 지우고 해당 범위의 최신 목록만 표시합니다. */
  function load(nextCursors: (string | null)[], scope?: JobsScope): void {
    if (busy.current) return;
    const request = ++generation.current;
    detailGeneration.current += 1;
    setSelected(null);
    setDetail({ status: 'idle' });
    setPage({ status: 'loading' });
    void loadJobsPage(nextCursors.at(-1) ?? null, scope).then(
      (result: JobsPageResult): void => {
        if (!mounted.current || request !== generation.current) return;
        setCursors(nextCursors);
        setPage(result);
      },
    );
  }
  /** 선택한 작업의 상세나 취소 결과만 반영하고 권한 오류는 목록도 숨깁니다. */
  async function read(jobId: string, cancelRevision?: string): Promise<void> {
    if (!('ok' in page) || !page.ok || busy.current) return;
    const request = ++detailGeneration.current;
    busy.current = cancelRevision !== undefined;
    setSelected(jobId);
    setDetail({ status: 'loading' });
    const result = await loadJobDetail(page.scope, jobId, cancelRevision);
    busy.current = false;
    if (!mounted.current || request !== detailGeneration.current) return;
    if (result.ok) setDetail({ status: 'ready', detail: result.detail });
    else {
      setDetail({ status: 'error', message: result.error.message });
      if (
        result.error.status === 401 ||
        result.error.status === 403 ||
        result.error.code === 'scope_changed'
      ) {
        setPage(result);
        setSelected(null);
        setDetail({ status: 'idle' });
      }
    }
  }
  /** 최신 첫 페이지를 읽을 뿐 새 분석을 실행하지 않습니다. */
  function refresh(): void {
    load([null]);
  }
  /** 이미 읽은 cursor 이력으로 이전 페이지를 조회합니다. */
  function previous(): void {
    if (cursors.length > 1 && 'ok' in page && page.ok)
      load(cursors.slice(0, -1), page.scope);
  }
  /** 서버의 다음 cursor만 사용하고 부분 조회의 새로고침 요구를 지킵니다. */
  function next(): void {
    if (
      'ok' in page &&
      page.ok &&
      page.page.nextCursor &&
      !page.page.requiresRefresh
    )
      load([...cursors, page.page.nextCursor], page.scope);
  }
  /** 행 선택은 읽기 동작으로만 연결합니다. */
  function select(jobId: string): void {
    void read(jobId);
  }
  /** 상세 재조회는 기존 선택을 사용합니다. */
  function refreshDetail(): void {
    if (selected) void read(selected);
  }
  /** 화면에서 조회한 작업 판본으로만 명시 취소하며 충돌을 자동 재시도하지 않습니다. */
  function cancel(): void {
    if (detail.status === 'ready')
      void read(detail.detail.job.job_id, detail.detail.job.job_revision);
  }
  return {
    page,
    detail,
    selected,
    pageNumber: cursors.length,
    canPrevious: cursors.length > 1,
    refresh,
    previous,
    next,
    select,
    refreshDetail,
    cancel,
  };
}
