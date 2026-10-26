import type { JSX } from 'react';
import type {
  AnalysisExecutionScope,
  AnalysisJob,
} from '@contracts/analysis.contract';
import { AnalysisResult } from '@renderer/domains/analysis/ui/AnalysisResult';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useExistingAnalysis } from '../model/useExistingAnalysis';
import styles from './RunAnalysisJob.module.scss';

export type RunAnalysisJobProps = {
  scope: AnalysisExecutionScope;
  jobId: string;
  onClose: () => void;
};
/** 작업·관점을 바꾸면 확인 상태도 새 수명으로 분리합니다. */
export function RunAnalysisJob(props: RunAnalysisJobProps): JSX.Element {
  return (
    <ExecutionSession
      key={JSON.stringify([props.scope, props.jobId])}
      {...props}
    />
  );
}
/** 이미 접수한 job의 확인·명시 실행·부분 결과·중단을 한 곳에서 보여 줍니다. */
function ExecutionSession({
  scope,
  jobId,
  onClose,
}: RunAnalysisJobProps): JSX.Element {
  const model = useExistingAnalysis(scope, jobId);
  const inspection = model.inspection;
  const detail = inspection?.detail;
  const job = detail?.job;
  return (
    <Dialog
      open
      onOpenChange={(open: boolean): void => {
        if (!open) onClose();
      }}
      title="기존 분석 작업 실행·재개"
      description="접수한 작업의 고정 입력과 저장 결과를 확인합니다."
      className={styles.dialog}
    >
      <div className={styles.workspace}>
        <section className={styles.basis} aria-label="실행 기준 확인">
          <h3>확인한 작업 기준</h3>
          <p className={styles.identifier}>{jobId}</p>
          {job && (
            <>
              <dl>
                <dt>생성할 문서</dt>
                <dd>
                  {job.targets
                    .map(
                      (target: AnalysisJob['targets'][number]): string =>
                        target.document,
                    )
                    .join(', ')}
                </dd>
                <dt>요청한 결과</dt>
                <dd>{job.outputs.join(' · ')}</dd>
                <dt>작업 관점</dt>
                <dd>
                  {job.analysis_basis_ref?.profile.profile_id ??
                    job.actor.profile_id}
                </dd>
                <dt>원본 기준</dt>
                <dd>{job.basis_status}</dd>
                <dt>저장된 단계</dt>
                <dd>
                  {job.result_summary.saved_count} /{' '}
                  {job.result_summary.required_count}
                </dd>
                <dt>실행 사용권</dt>
                <dd>
                  {job.lease_status}
                  {job.lease_expires_at ? ` · ${job.lease_expires_at}` : ''}
                </dd>
                <dt>현재 확인 시각</dt>
                <dd>{inspection?.checkedAt}</dd>
              </dl>
              <details>
                <summary>고정 판본·필수 맥락</summary>
                <pre>
                  {JSON.stringify(
                    {
                      job_revision: job.job_revision,
                      source: job.source_ref,
                      input: job.active_input_ref,
                      basis: job.analysis_basis_ref,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
          {!inspection && !model.error && (
            <p>현재 권한·작업·저장 영수증을 확인하고 있습니다.</p>
          )}
          {model.error && (
            <StatusNotice tone="error" title="실행·조회 확인 안내">
              {model.error.message}
            </StatusNotice>
          )}
          {inspection && inspection.blockers.length > 0 && (
            <StatusNotice tone="warning" title="현재 실행 조건">
              <ul>
                {inspection.blockers.map(
                  (message: string, index: number): JSX.Element => (
                    <li key={`${index}:${message}`}>{message}</li>
                  ),
                )}
              </ul>
            </StatusNotice>
          )}
          <p className={styles.caption}>
            실행 시작 시 개인 Codex 준비 상태와 서버의 고정 규약·필수 맥락·현재
            권한을 다시 확인합니다. 재개는 실제 저장 영수증으로 확인된 단계를
            건너뛰며, 저장 여부가 미확인이면 멈춥니다.
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={model.refresh}
              disabled={model.busy || model.invalid}
            >
              최신 기준 다시 확인
            </Button>
            <Button
              onClick={model.execute}
              disabled={
                model.busy ||
                model.invalid ||
                !inspection?.mode ||
                !!model.error
              }
            >
              {inspection?.mode === 'resume'
                ? '확인한 기준으로 남은 단계 재개'
                : '확인한 작업 실행'}
            </Button>
            {detail?.local.status === 'running' && (
              <Button
                variant="secondary"
                onClick={model.stop}
                disabled={model.busy || model.invalid}
              >
                이 앱의 실행 중단
              </Button>
            )}
          </div>
          <p className={styles.caption}>
            창을 닫아도 실행은 계속됩니다. 로컬 중단 뒤에는 사용권 만료 또는
            서버의 중단 보고를 확인한 다음 명시 재개할 수 있습니다. 서버에서
            취소한 작업은 재개할 수 없습니다.
          </p>
        </section>
        <section className={styles.results} aria-label="보존된 분석 결과">
          <h3>실제 저장 결과</h3>
          {detail ? (
            <AnalysisResult
              detail={detail}
              source={{
                sourceVersion: detail.job.source_ref.source_version,
                sourceSha256: detail.job.source_ref.source_sha256,
                scope: { profileId: scope.profileId },
              }}
            />
          ) : (
            <p>확인한 서버 결과가 여기에 표시됩니다.</p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
