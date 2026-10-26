import { useState } from 'react';
import type { JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { AnalysisJob } from '@contracts/analysis.contract';
import type { ArtifactFile } from '@contracts/artifacts.contract';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { extractionRefs } from '../api/extraction.api';
import type {
  ExtractionArtifact,
  ExtractionRef,
  ExtractionScope,
} from '../api/extraction.api';
import { useExtraction } from '../model/useExtraction';
import styles from './ViewExtraction.module.scss';

export type ViewExtractionProps = {
  job: AnalysisJob;
  scope: ExtractionScope;
  extractionId?: string;
  onClose: () => void;
  onScopeInvalidated: () => void;
};
type ExtractionSessionProps = ViewExtractionProps & {
  extraction: ExtractionRef;
};
const uploadFormSchema = z.object({
  confirmed: z
    .boolean()
    .refine(
      (value: boolean): boolean => value,
      '선택 파일과 추출 기준을 확인해 주세요.',
    ),
});
type UploadFormValues = z.infer<typeof uploadFormSchema>;
type AttachmentFormProps = {
  file: ArtifactFile;
  disabled: boolean;
  onSubmit: () => void;
};

/** 파일 이름·실제 지문을 확인한 명시 제출만 업로드로 연결합니다. */
function AttachmentForm({
  file,
  disabled,
  onSubmit,
}: AttachmentFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UploadFormValues>({
    resolver: zodResolver(uploadFormSchema),
    defaultValues: { confirmed: false },
  });
  /** 검증된 확인값은 업로드 기준 자체를 변경하지 않습니다. */
  function submit(_values: UploadFormValues): void {
    onSubmit();
  }
  return (
    <form
      onSubmit={handleSubmit(submit)}
      className={styles.fileForm}
      aria-label="첨부 파일 등록"
    >
      <strong>{file.filename}</strong>
      <span>{file.sizeBytes.toLocaleString()} bytes</span>
      <code>{file.sha256}</code>
      <label>
        <input
          type="checkbox"
          {...register('confirmed')}
          disabled={disabled}
          aria-invalid={!!errors.confirmed}
          aria-describedby={
            errors.confirmed ? 'artifact-confirm-error' : undefined
          }
        />
        이 파일을 선택한 추출물에 첨부합니다.
      </label>
      {errors.confirmed && (
        <p id="artifact-confirm-error" role="alert">
          {errors.confirmed.message}
        </p>
      )}
      <Button type="submit" disabled={disabled}>
        선택 파일 첨부
      </Button>
    </form>
  );
}

/** 설명서·문자 페이지·고정 판본 근거와 첨부 전송을 한 추출 선택 안에 표시합니다. */
function ExtractionSession({
  job,
  scope,
  extraction,
  onScopeInvalidated,
}: ExtractionSessionProps): JSX.Element {
  const model = useExtraction({ job, scope, extraction, onScopeInvalidated });
  const data = model.read.status === 'ready' ? model.read.data : null;
  const manifest = data?.manifest;
  const locked = model.upload.status !== 'idle';
  return (
    <section
      className={styles.session}
      aria-label="선택 추출 결과"
      aria-busy={model.busy || model.read.status === 'loading'}
    >
      <header className={styles.head}>
        <div>
          <h3>추출 본문과 첨부 자료</h3>
          <p>
            추출 자료 조회는 AI 실행·위키 저장·사람 검토를 수행하지 않습니다.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={model.busy || model.read.status === 'loading'}
          onClick={model.refresh}
        >
          작업·추출 상태 다시 확인
        </Button>
      </header>
      {model.read.status === 'loading' && (
        <StatusNotice title="추출 자료를 불러오고 있습니다">
          실제 작업 이벤트와 추출 설명서의 판본을 확인합니다.
        </StatusNotice>
      )}
      {model.read.status === 'error' && (
        <StatusNotice tone="error" title="추출 결과 확인 안내">
          {model.read.message}
        </StatusNotice>
      )}
      {model.message && (
        <StatusNotice title="첨부·조회 안내">{model.message}</StatusNotice>
      )}
      {data && manifest && (
        <>
          <div className={styles.summary}>
            <span>
              {manifest.complete
                ? '원본 추출: 미독·경고 보고 없음'
                : '원본 추출: 불완전 보고'}
            </span>
            <span>
              {model.page?.complete
                ? '본문 조회: 끝 페이지까지 확인'
                : '본문 조회: 남은 페이지 있음'}
            </span>
            <span>방법: {manifest.method} · 제출자 자기보고</span>
          </div>
          {(!manifest.complete ||
            manifest.warnings.length > 0 ||
            manifest.omissions.length > 0) && (
            <StatusNotice tone="warning" title="추출 범위·완전성 안내">
              <p>
                본문 조회가 끝나도 원본을 빠짐없이 읽었다는 검증은 아닙니다.
              </p>
              <ul>
                {manifest.warnings.map(
                  (value: string, index: number): JSX.Element => (
                    <li key={`warning-${index}`}>경고: {value}</li>
                  ),
                )}
                {manifest.omissions.map(
                  (value: string, index: number): JSX.Element => (
                    <li key={`omission-${index}`}>누락: {value}</li>
                  ),
                )}
              </ul>
            </StatusNotice>
          )}
          <div className={styles.columns}>
            <section className={styles.content} aria-label="실제 추출 본문">
              <header>
                <h3>문자 본문</h3>
                <span>
                  {manifest.content_size_bytes.toLocaleString()} bytes
                </span>
              </header>
              {model.page ? (
                <>
                  <p className={styles.muted}>
                    문자 위치 {model.page.offset.toLocaleString()}부터 ·{' '}
                    {model.pageNumber}페이지
                  </p>
                  <pre>
                    {model.page.content || '이 판본의 본문은 비어 있습니다.'}
                  </pre>
                  {(model.page.truncated || model.page.skipped.length > 0) && (
                    <StatusNotice tone="warning" title="본문 부분 조회">
                      {model.page.truncated ? '조회 한도에 도달했습니다. ' : ''}
                      읽지 못한 항목 {model.page.skipped.length}개.
                      <details>
                        <summary>누락 근거</summary>
                        <pre>{JSON.stringify(model.page.skipped, null, 2)}</pre>
                      </details>
                    </StatusNotice>
                  )}
                  <footer>
                    <Button
                      variant="secondary"
                      disabled={model.busy || !model.canPrevious}
                      onClick={model.previous}
                    >
                      이전 본문 페이지
                    </Button>
                    <span>
                      {model.page.complete
                        ? '본문 페이지 조회 완료'
                        : '아직 읽지 않은 본문 페이지가 있습니다'}
                    </span>
                    <Button
                      variant="secondary"
                      disabled={model.busy || model.page.next_offset === null}
                      onClick={model.next}
                    >
                      다음 본문 페이지
                    </Button>
                  </footer>
                </>
              ) : (
                <StatusNotice title="본문 페이지 미확인">
                  설명서는 읽었지만 본문 조회를 완료하지 못했습니다. 상태를 다시
                  확인해 주세요.
                </StatusNotice>
              )}
            </section>
            <aside
              className={styles.provenance}
              aria-label="추출 원본·입력 근거"
            >
              <h3>당시 원본·입력 근거</h3>
              <dl>
                <dt>추출 ID</dt>
                <dd>{manifest.extraction_id}</dd>
                <dt>추출 판본</dt>
                <dd>{manifest.extraction_revision}</dd>
                <dt>문자 본문 SHA-256</dt>
                <dd>{manifest.content_sha256}</dd>
                <dt>실행 ID</dt>
                <dd>{manifest.run_id}</dd>
                <dt>추출 입력 준비 관점</dt>
                <dd>{manifest.actor.profile_id}</dd>
                <dt>현재 조회 관점</dt>
                <dd>{data.access.profile_id}</dd>
                <dt>제출 시각</dt>
                <dd>{manifest.created_at}</dd>
                <dt>원본 읽기 묶음</dt>
                <dd>{manifest.read_source_bundle.bundle_id}</dd>
                <dt>묶음 판본</dt>
                <dd>{manifest.read_source_bundle.bundle_revision}</dd>
              </dl>
              <h4>원본 선택·미독 범위</h4>
              <pre>{JSON.stringify(manifest.scope, null, 2)}</pre>
              <details>
                <summary>원본·작성자와 전체 설명서</summary>
                <pre>{JSON.stringify(manifest, null, 2)}</pre>
              </details>
            </aside>
          </div>
          <section className={styles.artifacts} aria-label="추출 첨부 자료">
            <header>
              <div>
                <h3>연결된 첨부 자료</h3>
                <p>
                  서버가 이 추출물에 명시 연결한 파일입니다. 기본 저장 이름은
                  artifact-ID.bin입니다.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={model.choose}
                disabled={model.busy || !!model.blocker || locked}
              >
                첨부 파일 선택
              </Button>
            </header>
            {data.artifacts.length === 0 ? (
              <p className={styles.muted}>
                현재 조회에서 연결된 첨부 파일이 없습니다. 조정 대기 파일은 이
                목록에 포함되지 않습니다.
              </p>
            ) : (
              <ul>
                {data.artifacts.map(
                  (artifact: ExtractionArtifact): JSX.Element => (
                    <li key={artifact.artifact_id}>
                      <div>
                        <strong>첨부 {artifact.artifact_id}</strong>
                        <span>
                          {artifact.size_bytes.toLocaleString()} bytes
                        </span>
                        <dl>
                          <dt>첨부 판본</dt>
                          <dd>{artifact.artifact_revision}</dd>
                          <dt>파일 SHA-256</dt>
                          <dd>{artifact.sha256}</dd>
                        </dl>
                      </div>
                      <Button
                        variant="secondary"
                        disabled={model.busy}
                        onClick={(): void => model.download(artifact)}
                      >
                        첨부 파일 저장
                      </Button>
                    </li>
                  ),
                )}
              </ul>
            )}
            <p className={styles.muted}>
              첨부 목록 판본: <code>{data.artifact_collection_revision}</code>
            </p>
            {model.blocker && (
              <StatusNotice title="첨부 자료 읽기 전용">
                {model.blocker}
              </StatusNotice>
            )}
            {!model.blocker && (
              <p className={styles.muted}>
                현재 작업·실행·입력 준비 참조를 확인했습니다. 전송 시 서버가
                현재 쓰기 권한과 고정 입력을 다시 검사합니다. 첨부 등록은
                위키·그래프 저장 또는 검토 승인이 아닙니다.
              </p>
            )}
            {model.file && (
              <AttachmentForm
                key={model.file.fileId}
                file={model.file}
                disabled={model.busy || !!model.blocker || locked}
                onSubmit={model.submit}
              />
            )}
            {model.upload.status === 'error' && (
              <StatusNotice tone="error" title="첨부 등록 안내">
                {model.upload.message}
              </StatusNotice>
            )}
            {(model.upload.status === 'unknown' ||
              model.upload.status === 'pending') && (
              <StatusNotice
                tone="warning"
                title={
                  model.upload.status === 'unknown'
                    ? '첨부 등록 결과 미확인'
                    : '첨부 연결 조정 대기'
                }
              >
                <p>{model.upload.message}</p>
                <dl>
                  <dt>동일 요청 ID</dt>
                  <dd>{model.upload.pending.request.requestId}</dd>
                  <dt>대상 추출 ID</dt>
                  <dd>{model.upload.pending.request.extractionId}</dd>
                  <dt>고정 작업 판본</dt>
                  <dd>{model.upload.pending.request.expectedJobRevision}</dd>
                </dl>
                <details>
                  <summary>고정 업로드 요청 근거</summary>
                  <pre>{JSON.stringify(model.upload.pending, null, 2)}</pre>
                </details>
                <Button
                  variant="secondary"
                  disabled={model.busy}
                  onClick={model.checkReceipt}
                >
                  같은 업로드 요청 영수증 확인
                </Button>
              </StatusNotice>
            )}
            {model.upload.status === 'complete' && (
              <StatusNotice tone="success" title="첨부 등록 완료">
                <p>{model.upload.message}</p>
                <p>
                  요청 {model.upload.outcome.request_id} · 첨부{' '}
                  {model.upload.outcome.artifact_id}
                </p>
                <details>
                  <summary>첨부 등록 영수증 상세</summary>
                  <pre>{JSON.stringify(model.upload.outcome, null, 2)}</pre>
                </details>
                {model.upload.outcome.cleanup_failures.length > 0 && (
                  <p>
                    등록은 완료되었지만 임시 파일 정리 경고가{' '}
                    {model.upload.outcome.cleanup_failures.length}개 있습니다.
                    업로드를 다시 실행하지 마세요.
                  </p>
                )}
              </StatusNotice>
            )}
          </section>
        </>
      )}
    </section>
  );
}

/** 실제 extraction_submitted 이벤트로만 선택하며 원래 3분할 작업 공간 위에 근거 창을 엽니다. */
export function ViewExtraction(props: ViewExtractionProps): JSX.Element {
  const refs = extractionRefs(props.job);
  const [selected, setSelected] = useState<ExtractionRef | null>(
    (): ExtractionRef | null => {
      if (props.extractionId)
        return (
          refs.find(
            (ref: ExtractionRef): boolean =>
              ref.extraction_id === props.extractionId,
          ) ?? null
        );
      return refs.at(-1) ?? null;
    },
  );
  /** 닫아도 미확인 업로드 요청은 같은 작업의 메모리 기록에 보존합니다. */
  function close(open: boolean): void {
    if (!open) props.onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={close}
      title="추출 결과·첨부 자료"
      description={`작업 ${props.job.job_id}`}
      className={styles.dialog}
    >
      <div className={styles.workspace}>
        <nav className={styles.extractions} aria-label="작업 추출 결과 목록">
          <h3>저장된 추출물</h3>
          {refs.length === 0 ? (
            <p>이 작업에 공개된 추출 제출 기록이 없습니다.</p>
          ) : (
            refs.map((ref: ExtractionRef, index: number): JSX.Element => (
              <button
                type="button"
                key={ref.extraction_id}
                aria-pressed={selected?.extraction_id === ref.extraction_id}
                onClick={(): void => setSelected(ref)}
              >
                <strong>추출 결과 {index + 1}</strong>
                <small>{ref.extraction_id}</small>
                <span>판본 {ref.extraction_revision}</span>
              </button>
            ))
          )}
        </nav>
        {!selected && refs.length > 0 && (
          <StatusNotice title="추출 선택 확인">
            전달된 추출 ID의 공개 이벤트를 확인하지 못했습니다. 목록에서 실제
            추출 판본을 선택해 주세요.
          </StatusNotice>
        )}
        {selected && (
          <ExtractionSession
            key={JSON.stringify([
              props.scope,
              props.job.job_id,
              selected.extraction_id,
              selected.extraction_revision,
            ])}
            {...props}
            extraction={selected}
          />
        )}
      </div>
    </Dialog>
  );
}
