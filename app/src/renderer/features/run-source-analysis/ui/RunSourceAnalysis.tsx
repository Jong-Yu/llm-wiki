import { useState } from 'react';
import type { JSX } from 'react';
import { RunAnalysisJob } from './RunAnalysisJob';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  AnalysisJob,
  AnalysisReceipt,
  AnalysisStartRequest,
} from '@contracts/analysis.contract';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { TextField } from '@renderer/shared/ui/TextField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useSourceAnalysis } from '../model/useSourceAnalysis';
import {
  analysisFormSchema,
  createAnalysisFormValues,
} from '../model/analysisForm.schema';
import type { AnalysisFormValues } from '../model/analysisForm.schema';
import type { AnalysisSourceSelection } from '../model/analysis.types';
import {
  AnalysisResult,
  resultTitle,
} from '@renderer/domains/analysis/ui/AnalysisResult';
import styles from './RunSourceAnalysis.module.scss';

type RunSourceAnalysisProps = {
  source: AnalysisSourceSelection;
  onClose: () => void;
};
/** 원본 선택별 폼 수명 안에서만 새 실행을 요청하고 이전 작업은 조회로 엽니다. */
export function RunSourceAnalysis({
  source,
  onClose,
}: RunSourceAnalysisProps): JSX.Element {
  const model = useSourceAnalysis(source);
  const [executionJob, setExecutionJob] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AnalysisFormValues, unknown>({
    resolver: zodResolver(analysisFormSchema),
    defaultValues: createAnalysisFormValues(),
  });
  const detail = model.detail;
  // 사용권은 실행 후에도 잠시 남습니다. 실제 종료 보고가 있으면 새 요청을 계속 잠그지 않습니다.
  const running =
    detail?.local.status === 'running' ||
    (detail?.job.lease_status === 'active' &&
      detail.job.state !== 'cancelled' &&
      detail.job.result_summary.status !== 'complete' &&
      detail.job.reported_status !== 'failed' &&
      detail.job.reported_status !== 'stopped');
  const disabled = model.busy || model.scopeInvalid;
  const pending =
    detail?.job.result_summary.status === 'pending_reconcile' ||
    (detail !== null &&
      (detail.receiptErrors.length > 0 ||
        detail.receipts.some(
          (receipt: AnalysisReceipt): boolean => receipt.saved === null,
        )));
  const startDisabled =
    disabled ||
    running ||
    pending ||
    model.error !== null ||
    model.list.status !== 'ready';
  const listIncomplete =
    model.list.status === 'ready' &&
    (!model.list.page.complete ||
      model.list.page.truncated ||
      model.list.page.skippedCount > 0 ||
      model.list.page.requiresRefresh);

  /** 확인한 폼 값을 서버 계약의 생성 결과 목록으로 바꿔 한 번만 실행합니다. */
  async function submit(values: AnalysisFormValues): Promise<void> {
    const outputs: AnalysisStartRequest['outputs'] =
      values.outputs === 'wiki_ontology'
        ? ['wiki', 'ontology']
        : [values.outputs];
    await model.start(values.targetDocument, outputs);
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open: boolean): void => {
          if (!open) onClose();
        }}
        title="원본 분석·결과"
        description={source.title}
        className={styles.dialog}
      >
        <div className={styles.workspace}>
          <section className={styles.request} aria-label="새 분석 요청">
            <h3>새 분석 요청</h3>
            <p className={styles.caption}>
              선택한 UTF-8 원본의 고정 판본으로 개인 Codex를 실행합니다. 첫
              연결은 단일 문서·4 MiB 이하 원본을 지원합니다.
            </p>
            <form
              onSubmit={handleSubmit(submit)}
              noValidate
              className={styles.form}
            >
              <TextField
                {...register('targetDocument')}
                label="저장할 위키 경로"
                placeholder="분석/문서.md"
                description="서버의 상대 Markdown 경로입니다. 기존 문서는 현재 판본을 확인해 수정 전 파일을 보존합니다."
                error={errors.targetDocument?.message}
                disabled={startDisabled}
              />
              <SelectField
                {...register('outputs')}
                label="생성 결과"
                disabled={startDisabled}
                error={errors.outputs?.message}
              >
                <option value="wiki_ontology">위키·그래프</option>
                <option value="wiki">위키만</option>
                <option value="ontology">그래프만</option>
              </SelectField>
              <Button type="submit" disabled={startDisabled}>
                {model.busy ? '요청 처리 중' : '분석 시작'}
              </Button>
            </form>
            {pending ? (
              <StatusNotice tone="warning" title="저장 확인 후 새 분석 가능">
                저장 여부가 불명확한 결과가 있습니다. 현재 결과를 먼저
                새로고침해 주세요.
              </StatusNotice>
            ) : null}
            <p className={styles.caption}>
              창을 닫아도 실행은 이어집니다. 분석 중단은 아래 취소 버튼을 사용해
              주세요.
            </p>
          </section>
          <section className={styles.history} aria-label="기존 분석 작업">
            <header className={styles.heading}>
              <h3>기존 분석 작업</h3>
              <Button
                variant="secondary"
                onClick={model.refresh}
                disabled={disabled}
              >
                현재 결과 새로고침
              </Button>
            </header>
            {model.error ? (
              <StatusNotice tone="error" title="분석 상태 확인 안내">
                {model.error.message}
              </StatusNotice>
            ) : null}
            {model.list.status === 'loading' ? (
              <p>작업 목록을 읽고 있습니다.</p>
            ) : null}
            {model.list.status === 'ready' &&
            model.list.page.items.length === 0 ? (
              <p className={styles.caption}>
                이 원본의 기존 분석 작업이 없습니다.
              </p>
            ) : null}
            {model.list.status === 'ready' ? (
              <ul className={styles.jobs} aria-label="분석 작업 목록">
                {model.list.page.items.map((job: AnalysisJob): JSX.Element => (
                  <li key={job.job_id}>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-pressed={detail?.job.job_id === job.job_id}
                      onClick={(): void => model.select(job.job_id)}
                    >
                      <span>
                        {job.targets
                          .map(
                            (target: AnalysisJob['targets'][number]): string =>
                              target.document,
                          )
                          .join(', ')}
                      </span>
                      <small>
                        {resultTitle(job)} · {job.created_at}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {listIncomplete ? (
              <StatusNotice tone="warning" title="일부 작업만 조회됨">
                조회 한도나 읽기 실패가 있어 현재 목록을 전체 작업으로 해석할 수
                없습니다.
              </StatusNotice>
            ) : null}
            {model.list.status === 'ready' && model.list.page.nextCursor ? (
              <Button
                variant="secondary"
                disabled={disabled || model.list.page.requiresRefresh}
                onClick={model.next}
              >
                다음 작업 페이지
              </Button>
            ) : null}
            {detail ? (
              <>
                <AnalysisResult detail={detail} source={source} />
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={(): void => setExecutionJob(detail.job.job_id)}
                >
                  기존 작업 실행·재개 확인
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    disabled ||
                    detail.job.state === 'cancelled' ||
                    detail.job.result_summary.status === 'complete'
                  }
                  onClick={model.cancel}
                >
                  분석 취소
                </Button>
              </>
            ) : null}
          </section>
        </div>
      </Dialog>
      {executionJob && (
        <RunAnalysisJob
          jobId={executionJob}
          scope={{ ...source.scope, connectionId: source.connectionId }}
          onClose={(): void => {
            setExecutionJob(null);
            model.refresh();
          }}
        />
      )}
    </>
  );
}
