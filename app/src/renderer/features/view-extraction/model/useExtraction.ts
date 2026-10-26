import { useEffect, useRef, useState } from 'react';
import type { AnalysisJob } from '@contracts/analysis.contract';
import type { ArtifactFile } from '@contracts/artifacts.contract';
import {
  chooseArtifact,
  downloadArtifact,
  expectedExtractionScope,
  extractionRefs,
  loadArtifactReceipt,
  loadExtraction,
  loadExtractionContent,
  loadExtractionJob,
  loadArtifactWritePermission,
  uploadArtifact,
  uploadBlocker,
} from '../api/extraction.api';
import type {
  ArtifactOutcome,
  ExtractionArtifact,
  ExtractionContentPage,
  ExtractionData,
  ExtractionFailure,
  ExtractionInput,
  ExtractionRef,
  ExtractionScope,
  PendingArtifact,
} from '../api/extraction.api';

type ReadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ExtractionData };
type UploadState =
  | { status: 'idle' }
  | { status: 'unknown' | 'pending'; pending: PendingArtifact; message: string }
  | { status: 'complete'; outcome: ArtifactOutcome; message: string }
  | { status: 'error'; message: string };
type ModelInput = {
  job: AnalysisJob;
  scope: ExtractionScope;
  extraction: ExtractionRef;
  onScopeInvalidated: () => void;
};
export type ExtractionModel = {
  read: ReadState;
  job: AnalysisJob;
  page: ExtractionContentPage | null;
  pageNumber: number;
  canPrevious: boolean;
  file: ArtifactFile | null;
  busy: boolean;
  message: string;
  upload: UploadState;
  blocker: string | null;
  refresh: () => void;
  previous: () => void;
  next: () => void;
  choose: () => void;
  submit: () => void;
  checkReceipt: () => void;
  download: (artifact: ExtractionArtifact) => void;
};
// 메모리 수명 안에서 닫기·다시 열기로 미확인 전송이 새 POST로 바뀌지 않게 합니다.
const uncertainUploads = new Map<string, PendingArtifact>();

/** 같은 사용자의 작업은 관점·정책 변경으로 미확인 전송 잠금을 우회하지 않습니다. */
function requestKey(scope: ExtractionScope, jobId: string): string {
  return JSON.stringify([
    scope.connectionId,
    scope.userId,
    scope.tenant,
    jobId,
  ]);
}

/** 읽기 페이지와 명시 전송을 분리하고 늦은 완료가 다른 추출 선택을 덮지 않습니다. */
export function useExtraction(input: ModelInput): ExtractionModel {
  const initial = useRef(input);
  const [read, setRead] = useState<ReadState>({ status: 'loading' });
  const [job, setJob] = useState<AnalysisJob>(input.job);
  const [pages, setPages] = useState<ExtractionContentPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [file, setFile] = useState<ArtifactFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [writeAllowed, setWriteAllowed] = useState(false);
  const [upload, setUpload] = useState<UploadState>((): UploadState => {
    const pending = uncertainUploads.get(
      requestKey(input.scope, input.job.job_id),
    );
    return pending
      ? {
          status: 'unknown',
          pending,
          message:
            '이 작업에 확인되지 않은 업로드 요청이 있습니다. 같은 요청의 영수증을 확인해 주세요.',
        }
      : { status: 'idle' };
  });
  const mounted = useRef(false);
  const generation = useRef(0);
  const operationBusy = useRef(false);
  const currentInput: ExtractionInput = {
    scope: input.scope,
    jobId: input.job.job_id,
    extraction: input.extraction,
  };

  /** 범위 변경은 부모가 이전 작업과 추출 자료를 함께 숨기도록 전달합니다. */
  function failure(error: ExtractionFailure): void {
    if (
      error.code === 'scope_changed' ||
      error.status === 401 ||
      error.status === 403
    ) {
      setRead({ status: 'error', message: error.message });
      initial.current.onScopeInvalidated();
    } else setMessage(error.message);
  }

  /** 새 조회는 미확인 요청을 보존하며 실제 작업과 설명서·첫 문자 페이지를 읽습니다. */
  async function initialise(): Promise<void> {
    const request = ++generation.current;
    const basis = initial.current;
    const query: ExtractionInput = {
      scope: basis.scope,
      jobId: basis.job.job_id,
      extraction: basis.extraction,
    };
    const [manifest, current, permission] = await Promise.all([
      loadExtraction(query),
      loadExtractionJob(basis.scope, basis.job.job_id),
      loadArtifactWritePermission(basis.scope),
    ]);
    if (!mounted.current || request !== generation.current) return;
    if (!manifest.ok || !current.ok) {
      const error = !manifest.ok
        ? manifest.error
        : !current.ok
          ? current.error
          : null;
      if (error) {
        setRead({ status: 'error', message: error.message });
        failure(error);
      }
      return;
    }
    if (
      !extractionRefs(current.data).some(
        (ref: ExtractionRef): boolean =>
          ref.extraction_id === query.extraction.extraction_id &&
          ref.extraction_revision === query.extraction.extraction_revision,
      )
    ) {
      setRead({
        status: 'error',
        message:
          '현재 작업 기록에서 이 추출 판본의 공개 근거를 확인하지 못했습니다.',
      });
      return;
    }
    setJob(current.data);
    setWriteAllowed(permission.ok && permission.data);
    if (!permission.ok) failure(permission.error);
    setRead({ status: 'ready', data: manifest.data });
    const content = await loadExtractionContent(query, manifest.data, 0);
    if (!mounted.current || request !== generation.current) return;
    if (content.ok) setPages([content.data]);
    else failure(content.error);
  }

  useEffect((): (() => void) => {
    mounted.current = true;
    void initialise();
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  /** 재조회는 작업 기준을 새로 읽는 명시 동작이며 미확인 전송을 해제하지 않습니다. */
  function refresh(): void {
    if (operationBusy.current) return;
    setRead({ status: 'loading' });
    setPages([]);
    setPageIndex(0);
    setFile(null);
    setMessage('');
    if (!uncertainUploads.has(requestKey(input.scope, input.job.job_id)))
      setUpload({ status: 'idle' });
    void initialise();
  }

  /** 이미 읽은 같은 판본의 이전 문자 페이지를 표시합니다. */
  function previous(): void {
    if (!operationBusy.current && pageIndex > 0) setPageIndex(pageIndex - 1);
  }

  /** 서버의 다음 문자 위치만 사용하며 페이지 읽기를 추출 성공으로 해석하지 않습니다. */
  async function readNext(): Promise<void> {
    const page = pages[pageIndex];
    if (
      operationBusy.current ||
      read.status !== 'ready' ||
      !page ||
      page.next_offset === null
    )
      return;
    if (pages[pageIndex + 1]) {
      setPageIndex(pageIndex + 1);
      return;
    }
    operationBusy.current = true;
    setBusy(true);
    setMessage('');
    const request = generation.current;
    const result = await loadExtractionContent(
      currentInput,
      read.data,
      page.next_offset,
    );
    operationBusy.current = false;
    if (!mounted.current || request !== generation.current) return;
    setBusy(false);
    if (result.ok) {
      setPages([...pages, result.data]);
      setPageIndex(pageIndex + 1);
    } else failure(result.error);
  }

  /** 안전한 네이티브 선택 결과만 보관하고 파일 내용은 renderer에 읽지 않습니다. */
  async function chooseFile(): Promise<void> {
    if (
      operationBusy.current ||
      read.status !== 'ready' ||
      upload.status !== 'idle' ||
      !writeAllowed ||
      uploadBlocker(job, read.data, input.scope)
    )
      return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('');
    const result = await chooseArtifact(input.scope);
    operationBusy.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) setFile(result.data);
    else if (result.error.code !== 'cancelled') failure(result.error);
  }

  /** 고정 요청의 완료를 표시하고 공개 참조만 다시 읽으며 작업 판본은 자동 교체하지 않습니다. */
  async function completed(outcome: ArtifactOutcome): Promise<void> {
    setUpload({
      status: 'complete',
      outcome,
      message:
        '첨부 자료가 작업의 추출물에 연결되었습니다. 다음 전송 전 작업 상태를 다시 확인해 주세요.',
    });
    setFile(null);
    const result = await loadExtraction(currentInput);
    if (!mounted.current) return;
    if (result.ok) setRead({ status: 'ready', data: result.data });
    else failure(result.error);
  }

  /** 업로드 전 최신 job을 대조하고 판본이 달라지면 새 사용자 확인을 요구합니다. */
  async function submitFile(): Promise<void> {
    if (
      operationBusy.current ||
      read.status !== 'ready' ||
      !file ||
      upload.status !== 'idle' ||
      !writeAllowed ||
      uploadBlocker(job, read.data, input.scope)
    )
      return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('');
    const latest = await loadExtractionJob(input.scope, job.job_id);
    if (!mounted.current) {
      operationBusy.current = false;
      return;
    }
    if (
      !latest.ok ||
      latest.data.job_revision !== job.job_revision ||
      latest.data.run_id !== job.run_id ||
      !job.run_id ||
      uploadBlocker(latest.data, read.data, input.scope)
    ) {
      operationBusy.current = false;
      setBusy(false);
      if (!latest.ok) failure(latest.error);
      setUpload({
        status: 'error',
        message:
          '전송 전 작업 상태가 바뀌었거나 준비를 확인하지 못했습니다. 파일은 보존했으며 작업 상태를 다시 확인해야 합니다.',
      });
      return;
    }
    const pending: PendingArtifact = {
      file,
      request: {
        connectionId: input.scope.connectionId,
        expectedScope: expectedExtractionScope(input.scope),
        fileId: file.fileId,
        requestId: crypto.randomUUID().replaceAll('-', ''),
        jobId: job.job_id,
        runId: job.run_id,
        expectedJobRevision: job.job_revision,
        bundleId: read.data.manifest.read_source_bundle.bundle_id,
        bundleRevision: read.data.manifest.read_source_bundle.bundle_revision,
        extractionId: input.extraction.extraction_id,
        extractionRevision: input.extraction.extraction_revision,
        contentSha256: file.sha256,
      },
    };
    // 전송 도중 창을 닫아도 같은 요청이 미확인 상태로 남도록 await 전에 기록합니다.
    const key = requestKey(input.scope, job.job_id);
    uncertainUploads.set(key, pending);
    const result = await uploadArtifact(pending);
    const uncertain =
      !result.ok &&
      (result.error.code === 'outcome_unknown' ||
        result.error.code === 'scope_changed' ||
        (result.error.status !== undefined && result.error.status >= 500));
    if (result.ok && result.data.state === 'complete')
      uncertainUploads.delete(key);
    else if (!result.ok && !uncertain) uncertainUploads.delete(key);
    operationBusy.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      if (result.data.state === 'complete') await completed(result.data);
      else
        setUpload({
          status: 'pending',
          pending,
          message:
            '파일 보존은 접수되었지만 작업 연결이 조정 대기 중입니다. 재전송하지 말고 같은 요청의 영수증을 확인해 주세요.',
        });
    } else if (uncertain) {
      setUpload({ status: 'unknown', pending, message: result.error.message });
      if (result.error.code === 'scope_changed') failure(result.error);
    } else {
      setUpload({ status: 'error', message: result.error.message });
      failure(result.error);
    }
  }

  /** 미확인 요청의 GET 영수증만 읽으며 404나 불명확한 결과도 재POST하지 않습니다. */
  async function check(): Promise<void> {
    if (
      operationBusy.current ||
      (upload.status !== 'unknown' && upload.status !== 'pending')
    )
      return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('');
    const pending = upload.pending;
    const result = await loadArtifactReceipt(input.scope, pending);
    if (result.ok && result.data.state === 'complete')
      uncertainUploads.delete(requestKey(input.scope, job.job_id));
    operationBusy.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      if (result.data.state === 'complete') await completed(result.data);
      else
        setUpload({
          status: 'pending',
          pending,
          message:
            '같은 요청의 파일은 보존되었지만 아직 공개 연결을 확인하지 못했습니다. 재전송하지 않습니다.',
        });
    } else {
      failure(result.error);
      setMessage(
        `${result.error.message} 요청 ${pending.request.requestId}의 결과는 아직 확정되지 않았습니다. 재전송하지 말고 요청 기록을 확인해 주세요.`,
      );
    }
  }

  /** 목록의 명시 첨부 참조를 main의 파일 저장 대화상자로 전달합니다. */
  async function saveFile(artifact: ExtractionArtifact): Promise<void> {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setMessage('');
    const result = await downloadArtifact(currentInput, artifact);
    operationBusy.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) setMessage(`${result.data} 파일을 저장했습니다.`);
    else if (result.error.code !== 'cancelled') failure(result.error);
  }
  /** UI 이벤트에서 시작한 비동기 동작만 실행합니다. */
  function next(): void {
    void readNext();
  }
  /** 파일 선택은 사용자 동작에서만 엽니다. */
  function choose(): void {
    void chooseFile();
  }
  /** 선택한 파일 하나만 명시 전송합니다. */
  function submit(): void {
    void submitFile();
  }
  /** 재전송 없이 같은 요청을 확인합니다. */
  function checkReceipt(): void {
    void check();
  }
  /** 선택 참조의 파일 저장만 실행합니다. */
  function download(artifact: ExtractionArtifact): void {
    void saveFile(artifact);
  }
  return {
    read,
    job,
    page: pages[pageIndex] ?? null,
    pageNumber: pageIndex + 1,
    canPrevious: pageIndex > 0,
    file,
    busy,
    message,
    upload,
    blocker:
      read.status === 'ready'
        ? !writeAllowed
          ? '현재 작업 공간에 원본·첨부 쓰기 권한이 없어 첨부 자료를 읽기만 합니다.'
          : uploadBlocker(job, read.data, input.scope)
        : '추출 자료를 확인한 뒤 첨부할 수 있습니다.',
    refresh,
    previous,
    next,
    choose,
    submit,
    checkReceipt,
    download,
  };
}
