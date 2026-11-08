import { documentDisplayName } from '@renderer/domains/documents';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import { Icon } from '@renderer/shared/ui/Icon';
import type {
  AnalysisDetail,
  AnalysisExecutionInspection,
  AnalysisDetailResult,
} from '@contracts/analysis.contract';
import type { QuestionSession } from '@contracts/questionRuns.contract';
import { analysisGateway } from '@renderer/platform/analysis';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { Button } from '@renderer/shared/ui/Button';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import {
  analysisStatus,
  assertSessionScope,
  readSessionScope,
  SessionScopeError,
  throwIfScopeError,
} from '../api/aiSessions.api';
import { AnalysisJobSkeleton } from './AnalysisJobSkeleton';
import styles from './AiSessions.module.scss';
import { KnowledgeComparisons } from './KnowledgeComparisons';
import {
  AnalysisJobContext,
  AnalysisReceiptDetails,
} from './AnalysisReceiptDetails';

type AnalysisJobWorkspaceProps = { jobId: string | null };
type JobOperation = 'prepare' | 'execute' | 'stop' | 'cancel';

/** 저장된 분석 작업을 직접 열고 조회·실행 준비·명시 실행·결과 확인을 같은 화면에서 처리합니다. */
export function AnalysisJobWorkspace({
  jobId,
}: AnalysisJobWorkspaceProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [inspection, setInspection] =
    useState<AnalysisExecutionInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelConfirmationId = useId();
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const cancelHeading = useRef<HTMLHeadingElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const scope = useRef<QuestionSession | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const valid = jobId !== null && /^[a-f0-9]{32}$/.test(jobId);

  const read = useCallback((): Promise<void> => {
    if (!jobId || !/^[a-f0-9]{32}$/.test(jobId) || pending.current)
      return Promise.resolve();
    const request = ++generation.current;
    pending.current = true;
    return readSessionScope()
      .then(async (session: QuestionSession): Promise<void> => {
        if (!mounted.current || request !== generation.current) return;
        setBusy(true);
        setError(null);
        setInspection(null);
        const result = await analysisGateway.read({
          connectionId: session.connectionId,
          jobId,
        });
        await assertSessionScope(session);
        if (!mounted.current || request !== generation.current) return;
        if (!result.ok) {
          throwIfScopeError(result.error);
          throw new Error(result.error.message);
        }
        if (result.data.job.job_id !== jobId)
          throw new Error('요청한 작업의 응답을 확인할 수 없습니다.');
        scope.current = session;
        setDetail(result.data);
        setInspection(null);
      })
      .catch((cause: unknown): void => {
        if (mounted.current && request === generation.current) {
          // 접근 범위 오류는 이전 판본의 상세·실행 준비까지 폐기합니다.
          if (cause instanceof SessionScopeError) {
            scope.current = null;
            setDetail(null);
            setInspection(null);
            setConfirmCancel(false);
          }
          setError(
            cause instanceof Error ? cause.message : '작업을 읽지 못했습니다.',
          );
        }
      })
      .finally((): void => {
        if (mounted.current && request === generation.current) {
          pending.current = false;
          setBusy(false);
        }
      });
  }, [jobId]);

  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      generation.current += 1;
      pending.current = false;
    };
  }, []);
  useEffect((): void => {
    if (active) void read();
  }, [active, read]);

  // 같은 화면의 확인 영역으로 이동하고 닫을 때 원래 행동으로 돌아갑니다.
  useEffect((): void => {
    if (confirmCancel && active) cancelHeading.current?.focus();
  }, [confirmCancel, active]);

  /** 조회한 작업 판본을 고정하고 오류 뒤에는 실행 준비를 다시 요구합니다. */
  async function operate(operation: JobOperation): Promise<void> {
    const session = scope.current;
    if (!session || !detail || !jobId || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await assertSessionScope(session);
      const request = { connectionId: session.connectionId, jobId };
      if (operation === 'prepare') {
        const result = await analysisGateway.inspectExecution(request);
        await assertSessionScope(session);
        if (!mounted.current) return;
        if (!result.ok) {
          throwIfScopeError(result.error);
          throw new Error(result.error.message);
        }
        if (result.data.detail.job.job_id !== jobId)
          throw new Error('요청한 작업의 실행 준비를 확인할 수 없습니다.');
        setInspection(result.data);
        setDetail(result.data.detail);
      } else {
        let result: AnalysisDetailResult;
        if (operation === 'execute') {
          if (!inspection?.mode || inspection.blockers.length) return;
          result = await analysisGateway.execute({
            ...request,
            expectedJobRevision: inspection.detail.job.job_revision,
            mode: inspection.mode,
          });
        } else if (operation === 'stop')
          result = await analysisGateway.stopLocal(request);
        else
          result = await analysisGateway.cancel({
            ...request,
            expectedJobRevision: detail.job.job_revision,
          });
        await assertSessionScope(session);
        if (!mounted.current) return;
        setInspection(null);
        if (!result.ok) {
          throwIfScopeError(result.error);
          throw new Error(result.error.message);
        }
        if (result.data.job.job_id !== jobId)
          throw new Error('요청한 작업의 처리 결과를 확인할 수 없습니다.');
        setDetail(result.data);
        setConfirmCancel(false);
        if (operation === 'cancel' && active)
          requestAnimationFrame((): void => statusHeading.current?.focus());
      }
    } catch (cause: unknown) {
      if (mounted.current) {
        setInspection(null);
        if (cause instanceof SessionScopeError) {
          scope.current = null;
          setDetail(null);
          setConfirmCancel(false);
        }
        setError(
          `${cause instanceof Error ? cause.message : '요청 결과를 확인하지 못했습니다.'} 작업 상태를 다시 읽은 뒤 확인해 주세요.`,
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      <WorkspacePage
        title="분석 작업"
        actions={
          <>
            {valid && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={(): void => {
                  void read();
                }}
              >
                새로고침
              </Button>
            )}
          </>
        }
      >
        {!valid ? (
          <p role="alert">
            작업 주소를 확인할 수 없습니다. 세션 목록에서 다시 선택해 주세요.
          </p>
        ) : (
          <div className={styles.detail}>
            <p className={styles.pageIntro}>
              AI가 문서를 분석한 작업의 진행 상태, 저장 결과, 기존 지식과의 대조
              결과를 확인하는 화면입니다.
            </p>
            {error && <p role="alert">{error}</p>}
            {busy && !detail && <AnalysisJobSkeleton />}
            {detail && (
              <>
                <WorkspaceSection title="현재 작업">
                  <div className={styles.jobSummary}>
                    <div>
                      <h3
                        className={styles.jobStatus}
                        ref={statusHeading}
                        tabIndex={-1}
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {detail.job.result_summary.status === 'complete' &&
                        detail.local.status === 'running'
                          ? '저장 완료 · 후속 AI 작업 진행 중'
                          : analysisStatus(detail.job)}
                      </h3>
                      <p>{detail.local.message}</p>
                    </div>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        disabled={busy || detail.job.state === 'cancelled'}
                        onClick={(): void => {
                          void operate('prepare');
                        }}
                      >
                        실행 가능 여부 확인
                      </button>
                      {detail.local.status === 'running' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(): void => {
                            void operate('stop');
                          }}
                        >
                          이 기기의 실행 중단
                        </button>
                      )}
                      {detail.job.state !== 'cancelled' &&
                        detail.job.result_summary.status !== 'complete' && (
                          <button
                            ref={cancelTrigger}
                            type="button"
                            disabled={busy}
                            aria-expanded={confirmCancel}
                            aria-controls={
                              confirmCancel ? cancelConfirmationId : undefined
                            }
                            onClick={(): void => setConfirmCancel(true)}
                          >
                            작업 취소 검토
                          </button>
                        )}
                    </div>
                  </div>
                  <div className={styles.factChips} aria-label="작업 정보">
                    {detail.job.targets.map(
                      (
                        target: AnalysisDetail['job']['targets'][number],
                      ): JSX.Element => (
                        <Link
                          key={target.document}
                          className={styles.factChip}
                          data-kind="link"
                          to={`/document?path=${encodeURIComponent(target.document)}`}
                        >
                          <Icon name="file-text" size={14} />
                          {documentDisplayName(target.document)}
                        </Link>
                      ),
                    )}
                    <Link
                      className={styles.factChip}
                      data-kind="link"
                      to={`/source?sourceId=${detail.job.source_ref.source_id}&version=${detail.job.source_ref.source_version}`}
                    >
                      <Icon name="external-link" size={14} />
                      분석 당시 원본 버전 열기
                    </Link>
                    <span className={styles.factChip}>
                      결과 {detail.job.result_summary.saved_count} /{' '}
                      {detail.job.result_summary.required_count} 저장
                    </span>
                  </div>
                  {detail.job.blockers.length > 0 &&
                    detail.job.result_summary.status !== 'complete' && (
                      <section className={styles.todo} aria-label="필요한 작업">
                        <h3>필요한 작업</h3>
                        <ul className={styles.checkList}>
                          {detail.job.blockers.map(
                            (blocker: string): JSX.Element => (
                              <li key={blocker}>{blocker}</li>
                            ),
                          )}
                        </ul>
                      </section>
                    )}
                  {inspection && (
                    <section
                      className={styles.resultGroup}
                      aria-label="실행 준비 결과"
                    >
                      <h3>실행 준비 결과</h3>
                      {inspection.blockers.length ? (
                        <ul className={styles.checkList}>
                          {inspection.blockers.map(
                            (blocker: string): JSX.Element => (
                              <li key={blocker}>{blocker}</li>
                            ),
                          )}
                        </ul>
                      ) : (
                        <p>
                          {inspection.mode === 'resume'
                            ? '기존 작업의 미완료 단계를 이어갈 수 있습니다.'
                            : inspection.mode === 'start'
                              ? '현재 기준으로 실행할 수 있습니다.'
                              : '현재 시작할 실행이 없습니다.'}
                        </p>
                      )}
                      {inspection.mode && (
                        <button
                          type="button"
                          className={styles.primaryAction}
                          disabled={busy || inspection.blockers.length > 0}
                          onClick={(): void => {
                            void operate('execute');
                          }}
                        >
                          {inspection.mode === 'resume'
                            ? '이 작업 이어서 실행'
                            : '이 작업 실행'}
                        </button>
                      )}
                    </section>
                  )}
                  {confirmCancel && (
                    <section
                      id={cancelConfirmationId}
                      className={styles.resultGroup}
                      aria-label="작업 취소 확인"
                    >
                      <h3 ref={cancelHeading} tabIndex={-1}>
                        작업 취소 확인
                      </h3>
                      <p>
                        이 분석 작업의 진행을 취소합니다. 이미 저장된 문서와
                        결과는 보존됩니다.
                      </p>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(): void => {
                            void operate('cancel');
                          }}
                        >
                          이 작업 취소
                        </button>
                        <button
                          type="button"
                          onClick={(): void => {
                            setConfirmCancel(false);
                            cancelTrigger.current?.focus();
                          }}
                        >
                          돌아가기
                        </button>
                      </div>
                    </section>
                  )}
                </WorkspaceSection>
                <WorkspaceSection title="저장 결과">
                  {detail.receiptErrors.map(
                    (
                      failure: AnalysisDetail['receiptErrors'][number],
                    ): JSX.Element => (
                      <p role="alert" key={failure.requestId}>
                        {failure.message}
                      </p>
                    ),
                  )}
                  {detail.receipts.length === 0 && (
                    <p>확인된 저장 기록이 없습니다.</p>
                  )}
                  {detail.receipts.map(
                    (
                      receipt: AnalysisDetail['receipts'][number],
                    ): JSX.Element => (
                      <article
                        className={styles.receipt}
                        key={receipt.request_id}
                      >
                        <p>
                          {receipt.saved === true
                            ? '저장됨'
                            : receipt.saved === false
                              ? '저장되지 않음'
                              : '저장 여부 미확인'}
                        </p>
                        {receipt.receipt && (
                          <Link
                            to={`/document?path=${encodeURIComponent(receipt.receipt.document)}`}
                          >
                            {documentDisplayName(receipt.receipt.document)}
                          </Link>
                        )}
                        {receipt.cleanup_failures.length > 0 && (
                          <p>
                            저장은 완료됐지만 임시 파일 정리 경고가 있습니다.
                            저장을 반복하지 마세요.
                          </p>
                        )}
                        <AnalysisReceiptDetails receipt={receipt} />
                      </article>
                    ),
                  )}
                </WorkspaceSection>
                <AnalysisJobContext job={detail.job} />
                <KnowledgeComparisons
                  key={jobId}
                  jobId={jobId}
                  documentPath={null}
                  watch={
                    detail.local.status === 'running' ||
                    detail.job.lease_status === 'active'
                  }
                />
              </>
            )}
          </div>
        )}
      </WorkspacePage>
    </div>
  );
}
