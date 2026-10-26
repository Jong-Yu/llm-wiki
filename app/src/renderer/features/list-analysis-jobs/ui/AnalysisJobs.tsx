import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import type {
  AnalysisExecutionScope,
  AnalysisJob,
} from '@contracts/analysis.contract';
import { z } from 'zod';
import {
  AnalysisResult,
  resultTitle,
} from '@renderer/domains/analysis/ui/AnalysisResult';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useAnalysisJobs } from '../model/useAnalysisJobs';
import styles from './AnalysisJobs.module.scss';

type AnalysisJobsProps = {
  navigation?: ReactNode;
  onRunJob?: (jobId: string, scope: AnalysisExecutionScope) => void;
  onViewExtraction?: (
    job: AnalysisJob,
    scope: {
      connectionId: string;
      userId: string;
      tenant: string;
      profileId: string;
      policyRevision: string;
    },
  ) => void;
};
const extractionEvent = z.object({
  kind: z.literal('reported'),
  details: z.object({
    operation: z.literal('extraction_submitted'),
    extraction_id: z.string().regex(/^[a-f0-9]{32}$/),
    extraction_revision: z.string().regex(/^[a-f0-9]{64}$/),
    run_id: z.string().regex(/^[a-f0-9]{32}$/),
  }),
});

/** 실제 작업 목록과 저장 영수증을 시안의 목록·결과·입력 정보 패널에 표시합니다. */
export function AnalysisJobs({
  navigation,
  onRunJob,
  onViewExtraction,
}: AnalysisJobsProps): JSX.Element {
  const model = useAnalysisJobs();
  const page = 'ok' in model.page && model.page.ok ? model.page : null;
  const failure =
    'ok' in model.page && !model.page.ok ? model.page.error : null;
  const detail = model.detail.status === 'ready' ? model.detail.detail : null;
  const job = detail?.job;
  return (
    <section className={styles.workspace} aria-label="AI 작업 공간">
      <WorkspaceToolbar className={styles.toolbar}>
        <h1>AI 작업</h1>
        {page && (
          <span>
            {page.scope.tenant} / {page.scope.profileId}
          </span>
        )}
        {navigation}
        <Link to="/documents">원본에서 분석 시작</Link>
        <Button
          variant="secondary"
          onClick={model.refresh}
          disabled={'status' in model.page}
        >
          새로고침
        </Button>
      </WorkspaceToolbar>
      <WorkspaceLayout className={styles.layout}>
        <WorkspacePane name="index">
          <aside className={styles.index} aria-label="AI 작업 목록">
            <header>
              <h2>내 분석 작업</h2>
              <p>현재 작업 공간에서 본인이 요청한 작업입니다.</p>
            </header>
            <div className={styles.scroll}>
              {'status' in model.page && (
                <StatusNotice title="작업을 불러오고 있습니다">
                  서버의 현재 목록을 확인하고 있습니다.
                </StatusNotice>
              )}
              {failure && (
                <StatusNotice
                  tone="error"
                  title="작업 목록을 확인하지 못했습니다"
                >
                  <p>{failure.message}</p>
                  <Link to="/setup/connection">서버 연결·작업 공간 선택</Link>
                </StatusNotice>
              )}
              {page && page.page.items.length === 0 && (
                <StatusNotice title="표시할 작업이 없습니다">
                  현재 페이지에서 조회된 작업이 없습니다.
                </StatusNotice>
              )}
              <ul>
                {page?.page.items.map((item: AnalysisJob): JSX.Element => (
                  <li key={item.job_id}>
                    <button
                      type="button"
                      aria-pressed={model.selected === item.job_id}
                      onClick={(): void => model.select(item.job_id)}
                    >
                      <strong>
                        {item.targets
                          .map(
                            (target: AnalysisJob['targets'][number]): string =>
                              target.document,
                          )
                          .join(', ')}
                      </strong>
                      <span>{resultTitle(item)}</span>
                      <small>{item.created_at}</small>
                    </button>
                  </li>
                ))}
              </ul>
              {page &&
                (!page.page.complete ||
                  page.page.truncated ||
                  page.page.skippedCount > 0 ||
                  page.page.requiresRefresh) && (
                  <StatusNotice tone="warning" title="조회 범위 안내">
                    {page.page.nextCursor
                      ? '다음 페이지에 작업이 더 있습니다. '
                      : '현재 조회가 완전하지 않습니다. '}
                    {page.page.truncated && '서버 조회 한도에 도달했습니다. '}
                    {page.page.skippedCount > 0 &&
                      `읽지 못한 항목 ${page.page.skippedCount}개. `}
                    {page.page.requiresRefresh &&
                      '목록이 변경되어 새로고침이 필요합니다.'}
                  </StatusNotice>
                )}
            </div>
            <footer>
              <span>{model.pageNumber}페이지</span>
              <div>
                <Button
                  variant="secondary"
                  onClick={model.previous}
                  disabled={!page || !model.canPrevious}
                >
                  이전 페이지
                </Button>
                <Button
                  variant="secondary"
                  onClick={model.next}
                  disabled={!page?.page.nextCursor || page.page.requiresRefresh}
                >
                  다음 페이지
                </Button>
              </div>
            </footer>
          </aside>
        </WorkspacePane>
        <WorkspacePane name="content">
          <section className={styles.result} aria-label="선택 작업 결과">
            <header>
              <h2>{job ? '분석 결과' : '저장된 작업 확인'}</h2>
              {model.selected && (
                <Button
                  variant="secondary"
                  onClick={model.refreshDetail}
                  disabled={model.detail.status === 'loading'}
                >
                  현재 결과 새로고침
                </Button>
              )}
            </header>
            <div className={styles.scroll}>
              {model.detail.status === 'idle' && (
                <div className={styles.empty}>
                  <h2>작업을 선택해 주세요</h2>
                  <p>
                    왼쪽에서 작업을 선택하면 실제 저장 결과와 근거 판본을 확인할
                    수 있습니다.
                  </p>
                </div>
              )}
              {model.detail.status === 'loading' && (
                <StatusNotice title="작업 결과를 불러오고 있습니다">
                  조회는 분석을 다시 실행하지 않습니다.
                </StatusNotice>
              )}
              {model.detail.status === 'error' && (
                <StatusNotice tone="error" title="작업 결과 확인 안내">
                  {model.detail.message}
                </StatusNotice>
              )}
              {detail && page && (
                <>
                  <AnalysisResult
                    detail={detail}
                    source={{
                      sourceVersion: detail.job.source_ref.source_version,
                      sourceSha256: detail.job.source_ref.source_sha256,
                      scope: { profileId: page.scope.profileId },
                    }}
                  />
                  {onRunJob && (
                    <Button
                      variant="secondary"
                      onClick={(): void =>
                        onRunJob(detail.job.job_id, page.scope)
                      }
                    >
                      기존 작업 실행·재개 확인
                    </Button>
                  )}
                  {onViewExtraction &&
                    detail.job.events.some(
                      (event: AnalysisJob['events'][number]): boolean =>
                        extractionEvent.safeParse(event).success,
                    ) && (
                      <Button
                        variant="secondary"
                        onClick={(): void =>
                          onViewExtraction(detail.job, page.scope)
                        }
                      >
                        추출 결과·첨부 자료 보기
                      </Button>
                    )}
                  {detail.job.state !== 'cancelled' &&
                    detail.job.result_summary.status !== 'complete' && (
                      <Button variant="secondary" onClick={model.cancel}>
                        이 작업 취소
                      </Button>
                    )}
                </>
              )}
            </div>
          </section>
        </WorkspacePane>
        <WorkspacePane name="inspector">
          <aside className={styles.context} aria-label="작업 정보">
            <h2>작업 정보</h2>
            {job ? (
              <dl>
                <dt>작업 번호</dt>
                <dd>{job.job_id}</dd>
                <dt>작업 접수 관점</dt>
                <dd>{job.actor.profile_id}</dd>
                <dt>원본 ID</dt>
                <dd>{job.source_ref.source_id}</dd>
                <dt>입력 원본 판본</dt>
                <dd>{job.source_ref.source_version}</dd>
                <dt>원본 SHA-256</dt>
                <dd>{job.source_ref.source_sha256}</dd>
                <dt>요청 시각</dt>
                <dd>{job.created_at}</dd>
                <dt>결과</dt>
                <dd>{resultTitle(job)}</dd>
              </dl>
            ) : (
              <p>작업을 선택하면 입력과 저장 상태를 확인합니다.</p>
            )}
            <p>작업 조회와 새 AI 실행은 각각 별도의 동작입니다.</p>
          </aside>
        </WorkspacePane>
      </WorkspaceLayout>
    </section>
  );
}
