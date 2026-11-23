import { sameAccessRevision } from '@contracts/connection.contract';
import type {
  AnalysisDetail,
  AnalysisExecutionInspection,
} from '@contracts/analysis.contract';
import type {
  ConversionSource,
  SourceConversionScope,
  SourceConversionRun,
} from '@contracts/sourceConversion.contract';
import { importProcessingApi } from '../api/importProcessing.api';
import type {
  ImportRegisteredSource,
  ImportProcessingApi,
  ImportProcessingError,
  ImportProcessingSnapshot,
} from './importProcessing.types';
import type { DocumentTaskDetailResult } from '@contracts/documentTasks.contract';

type RestoredTask = Extract<DocumentTaskDetailResult, { ok: true }>['data'];

/** 화면을 떠나도 동일 세션의 원본·요청·영수증을 유지하는 등록 후 처리 흐름입니다. */
export class ImportProcessingSession {
  readonly #scope: SourceConversionScope;
  readonly #registered: ImportRegisteredSource;
  readonly #source: ConversionSource;
  readonly #targetDocument: string;
  readonly #extract: boolean;
  readonly #api: ImportProcessingApi;
  readonly #listeners = new Set<() => void>();
  #registrationRequestId: string | null = null;
  #registrationUnconfirmed = false;
  #jobId: string | null = null;
  #mode: 'start' | 'resume' | null = null;
  #conversionRequested = false;
  #preparationRequested = false;
  #autoExecuted = false;
  #restored = false;
  #snapshot: ImportProcessingSnapshot;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    scope: SourceConversionScope,
    registered: ImportRegisteredSource,
    targetDocument: string,
    extract: boolean,
    api: ImportProcessingApi = importProcessingApi,
    restored?: RestoredTask,
  ) {
    this.#scope = scope;
    this.#registered = registered;
    this.#targetDocument = targetDocument;
    this.#extract = extract;
    this.#api = api;
    const item = registered.item;
    this.#source = {
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceSha256: item.sourceSha256,
      registrationRevision: item.registrationRevision,
    };
    this.#snapshot = {
      taskId: null,
      busy: false,
      phase: 'idle',
      message: '원본을 보관했습니다. 본문 변환을 시작할 수 있습니다.',
      error: null,
      conversion: null,
      detail: null,
      canRetryConversion: false,
      canPrepare: true,
      canExecute: false,
      canRefresh: false,
      scopeInvalid: false,
      document: null,
      cleanupWarningCount: registered.cleanupWarningCount,
    };
    if (restored) this.#restore(restored);
  }

  /** 저장된 식별자를 복원하되 조회로 새로운 변환·접수·AI 실행을 시작하지 않습니다. */
  #restore(data: RestoredTask): void {
    this.#restored = true;
    this.#autoExecuted = true;
    this.#registrationRequestId = data.task.registration.requestId;
    this.#registrationUnconfirmed =
      data.task.registration.state === 'unconfirmed';
    this.#jobId = data.task.registration.jobId;
    this.#update({ taskId: data.task.taskId, canRefresh: true, error: null });
    if (data.conversion) {
      this.#conversionRequested = true;
      this.#applyConversion(data.conversion);
    }
    if (data.analysis) this.#applyDetail(data.analysis);
    else if (this.#registrationUnconfirmed) {
      this.#update({
        phase: 'planning_unconfirmed',
        canPrepare: false,
        canRetryConversion: false,
        message:
          '분석 접수 결과를 확인해야 합니다. 같은 요청의 저장 상태만 조회합니다.',
      });
    } else if (
      !data.conversion ||
      (data.conversion.state === 'complete' &&
        data.conversion.receiptState === 'saved' &&
        data.conversion.report?.complete)
    ) {
      this.#update({
        phase: 'ready',
        canPrepare: true,
        message:
          '보관한 원본의 미완료 처리를 시작할 수 있습니다. 아직 실행하지 않았습니다.',
      });
    }
    const failures = data.errors.filter(
      (failure: RestoredTask['errors'][number]): boolean =>
        failure.code !== 'task_history_write_failed',
    );
    if (failures.length)
      this.#update({
        error: failures
          .map(
            (failure: RestoredTask['errors'][number]): string =>
              failure.message,
          )
          .join(' · '),
      });
  }

  /** 실행 요청 전에 보호 기록을 확정해 앱이 종료돼도 같은 접수만 확인합니다. */
  async #ensureTask(): Promise<boolean> {
    if (this.#snapshot.taskId || !this.#api.createTask) return true;
    const result = await this.#api.createTask(
      this.#scope,
      this.#registered,
      this.#targetDocument,
    );
    if (!result.ok) {
      this.#fail(result.error);
      return false;
    }
    this.#registrationRequestId = result.data.registration.requestId;
    this.#update({ taskId: result.data.taskId });
    if (
      result.data.registration.state !== 'not_started' ||
      result.data.conversions.length
    ) {
      if (this.#api.readTask) {
        const read = await this.#api.readTask(this.#scope, result.data.taskId);
        if (!read.ok) {
          this.#fail(read.error);
          return false;
        }
        this.#restore(read.data);
      }
    }
    return true;
  }

  /** React 외부 저장소는 변경이 없을 때 같은 snapshot 참조를 반환합니다. */
  getSnapshot = (): ImportProcessingSnapshot => this.#snapshot;
  /** 복원한 세션만 새 읽기 결과를 반영하고 진행 중인 등록 흐름은 덮지 않습니다. */
  observeTask = (detail: RestoredTask): void => {
    if (
      !this.#snapshot.busy &&
      (this.#restored ||
        ['conversion_unconfirmed', 'planning_unconfirmed'].includes(
          this.#snapshot.phase,
        ))
    )
      this.#restore(detail);
  };
  /** 구독 해제는 서버 작업을 취소하거나 등록 기록을 지우지 않습니다. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  };
  /** 확인된 결과를 보존하면서 바뀐 상태만 구독 화면에 알립니다. */
  #update(patch: Partial<ImportProcessingSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#listeners.forEach((listener: () => void): void => listener());
  }
  /** 권한 오류 이후에는 이전 범위의 실행·조회 버튼을 잠급니다. */
  #fail(
    error: ImportProcessingError,
    phase: ImportProcessingSnapshot['phase'] = 'error',
  ): void {
    const invalid =
      error.status === 401 ||
      error.status === 403 ||
      [
        'scope_changed',
        'connection_changed',
        'access_changed',
        'subject_changed',
        'selection_required',
      ].includes(error.code);
    this.#update({
      error: error.message,
      phase,
      canExecute: false,
      scopeInvalid: this.#snapshot.scopeInvalid || invalid,
      ...(invalid
        ? { canPrepare: false, canRetryConversion: false, canRefresh: false }
        : {}),
    });
  }
  /** 요청 하나의 수명을 잠가 중복 클릭으로 새로운 작업을 만들지 않습니다. */
  async #run(operation: () => Promise<void>): Promise<void> {
    if (this.#snapshot.busy || this.#snapshot.scopeInvalid) return;
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#update({ busy: true, error: null });
    try {
      await operation();
    } catch {
      this.#fail({
        code: 'outcome_unknown',
        message:
          '처리 응답을 확인하지 못했습니다. 원본을 재등록하지 말고 같은 처리 상태를 다시 확인해 주세요.',
      });
    } finally {
      this.#update({ busy: false });
      this.#scheduleRefresh();
    }
  }
  /** 화면 구독과 별도로 진행을 이어가며 확정 실패·미확정 결과에서는 자동 재실행하지 않습니다. */
  #scheduleRefresh(): void {
    if (
      this.#snapshot.scopeInvalid ||
      !['converting', 'planning', 'running'].includes(this.#snapshot.phase)
    )
      return;
    this.#refreshTimer = setTimeout((): void => {
      this.#refreshTimer = null;
      void this.refresh();
    }, 1500);
  }
  /** 서버가 읽어 준 변환을 원래 원본 판본과 대조합니다. */
  #sameConversion(run: SourceConversionRun): boolean {
    return (
      run.source.sourceId === this.#source.sourceId &&
      run.source.sourceVersion === this.#source.sourceVersion &&
      run.source.sourceSha256 === this.#source.sourceSha256 &&
      run.source.registrationRevision === this.#source.registrationRevision
    );
  }
  /** 변환의 부분·실패·영수증 미확정을 원본 보관 완료와 별도로 표시합니다. */
  #applyConversion(run: SourceConversionRun | null): boolean {
    if (!run) {
      this.#update({
        phase: 'conversion_unconfirmed',
        canRefresh: true,
        canRetryConversion: false,
        canPrepare: false,
        message:
          '변환 결과가 아직 확인되지 않았습니다. 새 변환을 시작하지 않고 동일 원본의 상태를 확인해 주세요.',
      });
      return false;
    }
    if (!this.#sameConversion(run)) {
      this.#fail({
        code: 'scope_changed',
        message:
          '변환 결과의 원본 버전이 등록한 원본과 다릅니다. 기존 원본을 보존하고 연결을 중단했습니다.',
      });
      return false;
    }
    this.#update({
      conversion: run,
      canPrepare: false,
      canRefresh: true,
      cleanupWarningCount:
        this.#registered.cleanupWarningCount + (run.cleanupWarning ? 1 : 0),
    });
    if (
      run.state === 'running' ||
      run.state === 'cancelling' ||
      run.receiptState === 'pending'
    ) {
      this.#update({
        phase: 'converting',
        canRetryConversion: false,
        message: run.message || '보관한 원본을 변환하고 있습니다.',
      });
      return false;
    }
    if (
      run.state === 'report_unconfirmed' ||
      run.receiptState === 'unconfirmed'
    ) {
      this.#update({
        phase: 'conversion_unconfirmed',
        canRetryConversion: false,
        message:
          '변환 보고의 저장 결과를 확인 중입니다. 원본을 다시 올리지 않고 같은 보고를 조회합니다.',
      });
      return false;
    }
    if (
      run.state !== 'complete' ||
      run.receiptState !== 'saved' ||
      !run.reference ||
      !run.report?.complete
    ) {
      this.#update({
        phase: 'conversion_failed',
        canRetryConversion: true,
        message:
          run.message ||
          '원본은 보관됐지만 전체 본문 변환을 완료하지 못했습니다. 미독 구간과 변환 안내를 확인해 주세요.',
      });
      return false;
    }
    if (
      run.reference.sourceId !== this.#source.sourceId ||
      run.reference.sourceVersion !== this.#source.sourceVersion ||
      run.reference.sourceSha256 !== this.#source.sourceSha256 ||
      run.reference.registrationRevision !==
        this.#source.registrationRevision ||
      run.reference.requestId !== run.requestId
    ) {
      this.#fail({
        code: 'scope_changed',
        message:
          '변환 확인 결과이 원래 요청과 일치하지 않아 분석에 전달하지 않았습니다.',
      });
      return false;
    }
    this.#update({
      phase: 'planning',
      canRetryConversion: false,
      message:
        '변환 보고를 저장했습니다. 내용을 보존하는 Markdown 등록 작업을 준비합니다.',
    });
    return true;
  }
  /** 원본 하나를 단일 Markdown 등록 작업으로 접수하고 불명확한 결과는 같은 요청으로 조회합니다. */
  async #prepare(): Promise<void> {
    if (!this.#preparationRequested || this.#snapshot.scopeInvalid) return;
    this.#registrationRequestId ??= crypto.randomUUID().replaceAll('-', '');
    const reference = this.#snapshot.conversion?.reference;
    const result = await this.#api.register(this.#scope, {
      connectionId: this.#scope.connectionId,
      ...this.#source,
      targetDocument: this.#targetDocument,
      outputs: ['wiki', 'ontology'],
      registration: {
        requestId: this.#registrationRequestId,
        title: this.#registered.item.title,
        ...(reference
          ? {
              conversionRef: {
                conversionId: reference.conversionId,
                conversionRevision: reference.conversionRevision,
              },
            }
          : {}),
      },
      ...(this.#snapshot.taskId ? { taskId: this.#snapshot.taskId } : {}),
    });
    if (!result.ok) {
      this.#registrationUnconfirmed =
        result.error.status === undefined || result.error.status >= 500;
      this.#update({
        canPrepare: !this.#registrationUnconfirmed,
        canRefresh: true,
      });
      this.#fail(
        result.error,
        this.#registrationUnconfirmed ? 'planning_unconfirmed' : 'error',
      );
      return;
    }
    if (
      result.data.job.source_ref.source_id !== this.#source.sourceId ||
      result.data.job.source_ref.source_version !==
        this.#source.sourceVersion ||
      result.data.job.targets[0]?.document !== this.#targetDocument
    ) {
      this.#fail({
        code: 'scope_changed',
        message:
          '이전 접수의 원본·대상이 다릅니다. 기존 요청을 보존하고 새 처리를 중단했습니다.',
      });
      return;
    }
    this.#jobId = result.data.job.job_id;
    this.#registrationUnconfirmed = false;
    if (this.#applyDetail(result.data)) await this.#inspect();
  }
  /** 저장 영수증만 Markdown·온톨로지의 완료와 문서 이동 근거로 사용합니다. */
  #applyDetail(detail: AnalysisDetail): boolean {
    const job = detail.job;
    if (
      job.job_id !== this.#jobId ||
      job.tenant !== this.#scope.tenant ||
      job.user_id !== this.#scope.userId ||
      job.actor.profile_id !== this.#scope.profileId ||
      !sameAccessRevision(
        {
          policyRevision: job.actor.policy_revision,
          accessRevision: job.actor.access_revision,
        },
        this.#scope,
      ) ||
      job.targets.length !== 1 ||
      job.targets[0]?.document !== this.#targetDocument
    ) {
      this.#fail({
        code: 'scope_changed',
        message:
          '분석 작업의 대상·권한 기준이 현재 등록과 달라 결과를 표시하지 않았습니다.',
      });
      return false;
    }
    // 신규 등록은 기존 문서의 저장 기준을 승계하지 않습니다. 실제 서버 job이 부재 기준을 읽었는지 실행 전마다 확인합니다.
    const target = job.targets[0];
    if (
      target &&
      (target.source_revision !== null || target.state_revision !== null)
    ) {
      this.#update({ detail, canPrepare: false, canRefresh: true });
      this.#fail({
        code: 'target_exists',
        message:
          '이 저장 경로에 이미 문서가 있습니다. 기존 문서를 수정하지 않았습니다. 보관한 원본은 유지되며, 다른 문서 등록에서 번호를 붙여 다시 등록해 주세요.',
      });
      return false;
    }
    const saved = detail.receipts.filter(
      (receipt: AnalysisDetail['receipts'][number]): boolean =>
        receipt.state === 'complete' &&
        receipt.saved === true &&
        receipt.receipt?.document === this.#targetDocument &&
        receipt.current_output?.status === 'current',
    );
    const wikiSaved = saved.some(
      (receipt: AnalysisDetail['receipts'][number]): boolean =>
        receipt.receipt?.stage === 'prepare_wiki',
    );
    const ontologySaved = saved.some(
      (receipt: AnalysisDetail['receipts'][number]): boolean =>
        receipt.receipt?.stage === 'extract_ontology',
    );
    const complete =
      wikiSaved &&
      (!this.#extract || ontologySaved) &&
      job.result_summary.status === 'complete';
    // 재실행 직후에는 이전 실패 보고가 남아 있어도 현재 로컬 실행을 우선합니다.
    const stopped =
      detail.local.status !== 'running' &&
      (detail.local.status === 'failed' ||
        detail.local.status === 'stopped' ||
        job.reported_status === 'failed' ||
        job.reported_status === 'stopped' ||
        job.state === 'cancelled');
    const active =
      !stopped &&
      (detail.local.status === 'running' || job.lease_status === 'active');
    const following = complete && detail.local.status === 'running';
    this.#update({
      detail,
      document: wikiSaved ? this.#targetDocument : null,
      phase: following
        ? 'running'
        : complete
          ? 'complete'
          : active
            ? 'running'
            : stopped
              ? 'stopped'
              : wikiSaved
                ? 'partial'
                : 'ready',
      error:
        stopped && !complete
          ? detail.local.message ||
            '분석이 중단되었습니다. 작업 상태를 확인한 뒤 다시 실행해 주세요.'
          : null,
      canExecute: false,
      canPrepare: false,
      canRefresh: true,
      cleanupWarningCount:
        this.#registered.cleanupWarningCount +
        (this.#snapshot.conversion?.cleanupWarning ? 1 : 0) +
        detail.receipts.reduce(
          (
            count: number,
            receipt: AnalysisDetail['receipts'][number],
          ): number => count + receipt.cleanup_failures.length,
          0,
        ),
      message: following
        ? '문서·관계 저장이 확인됐습니다. 후속 AI 작업이 계속 진행 중입니다.'
        : complete
          ? this.#extract
            ? 'Markdown 본문과 관계 추출의 저장 결과를 확인했습니다. 추출된 관계는 검토 전 상태입니다.'
            : 'Markdown 본문의 저장 결과를 확인했습니다.'
          : active
            ? '선택한 개인 CLI가 작업을 진행 중입니다. 실제 저장 결과를 확인하고 있습니다.'
            : stopped
              ? detail.local.message ||
                '분석이 중단되었습니다. 작업 상태를 확인한 뒤 다시 실행해 주세요.'
              : wikiSaved
                ? 'Markdown 본문은 저장됐습니다. 후속 관계 추출 상태를 확인해 주세요.'
                : detail.local.message ||
                  '분석 작업이 준비됐습니다. 개인 AI 실행은 아직 완료되지 않았습니다.',
    });
    return true;
  }
  /** 실제 서버 검사 결과의 실행 가능 모드와 현재 job revision을 사용합니다. */
  #applyInspection(inspection: AnalysisExecutionInspection): boolean {
    if (!this.#applyDetail(inspection.detail)) return false;
    this.#mode = inspection.blockers.length === 0 ? inspection.mode : null;
    const canExecute =
      this.#mode !== null && this.#snapshot.phase !== 'complete';
    this.#update({
      canExecute,
      ...(inspection.blockers.length > 0
        ? {
            message: [this.#snapshot.error, ...inspection.blockers]
              .filter(Boolean)
              .join(' · '),
          }
        : {}),
    });
    return canExecute;
  }
  /** 조회는 저장 상태와 실행 준비만 확인하고 새 실행을 만들지 않습니다. */
  async #inspect(): Promise<void> {
    if (!this.#jobId) return;
    const result = await this.#api.inspectJob(this.#scope, this.#jobId);
    if (!result.ok) {
      this.#fail(result.error);
      return;
    }
    this.#applyInspection(result.data);
  }
  /** 명시 시작에서만 새 로컬 변환을 시작하며 이미 있는 처리 기록은 먼저 읽습니다. */
  begin = async (): Promise<void> => {
    await this.#run(async (): Promise<void> => {
      if (!(await this.#ensureTask())) return;
      if (this.#restored && (this.#registrationUnconfirmed || this.#jobId)) {
        await this.#refresh();
        return;
      }
      if (this.#restored) this.#autoExecuted = false;
      this.#restored = false;
      this.#preparationRequested = true;
      if (this.#registrationUnconfirmed || this.#jobId) {
        await this.#refresh();
        await this.#autoExecute();
        return;
      }
      if (['md', 'txt'].includes(this.#registered.item.format)) {
        await this.#prepare();
        await this.#autoExecute();
        return;
      }
      if (
        this.#snapshot.conversion &&
        this.#applyConversion(this.#snapshot.conversion)
      ) {
        await this.#prepare();
        await this.#autoExecute();
        return;
      }
      const existing = await this.#api.conversionRead(
        this.#scope,
        this.#source,
        this.#snapshot.taskId ?? undefined,
      );
      if (!existing.ok) {
        this.#update({ canPrepare: true });
        this.#fail(existing.error);
        return;
      }
      if (existing.data || this.#conversionRequested) {
        if (this.#applyConversion(existing.data)) {
          await this.#prepare();
          await this.#autoExecute();
        }
        return;
      }
      this.#conversionRequested = true;
      this.#update({
        phase: 'converting',
        canPrepare: false,
        canRefresh: true,
        message: '보관한 원본에서 본문을 변환합니다.',
      });
      const started = await this.#api.conversionStart(
        this.#scope,
        this.#source,
        this.#snapshot.taskId ?? undefined,
      );
      if (!started.ok) {
        this.#conversionFailure(started.error);
        return;
      }
      if (this.#applyConversion(started.data)) {
        await this.#prepare();
        await this.#autoExecute();
      }
    });
  };
  /** 알 수 없는 변환 시작 결과는 읽기로 확인하며 확정 실패만 재시도를 엽니다. */
  #conversionFailure(error: ImportProcessingError): void {
    const definiteLocalFailure = [
      'converter_unavailable',
      'conversion_busy',
      'unsupported_platform',
      'invalid_request',
    ].includes(error.code);
    if (error.notSent) this.#conversionRequested = false;
    const uncertain =
      !error.notSent &&
      !definiteLocalFailure &&
      (error.code === 'outcome_unknown' ||
        error.status === undefined ||
        error.status >= 500);
    this.#update({
      canRefresh: true,
      canRetryConversion: !uncertain,
      canPrepare: false,
    });
    this.#fail(
      error,
      uncertain ? 'conversion_unconfirmed' : 'conversion_failed',
    );
  }
  /** 부분·실패 변환만 명시 재시도하며 원본 등록과 기존 계획을 반복하지 않습니다. */
  retryConversion = async (): Promise<void> => {
    if (
      !this.#snapshot.canRetryConversion ||
      this.#registrationUnconfirmed ||
      this.#jobId !== null
    )
      return;
    await this.#run(async (): Promise<void> => {
      if (!(await this.#ensureTask())) return;
      this.#restored = false;
      this.#autoExecuted = false;
      this.#preparationRequested = true;
      this.#conversionRequested = true;
      this.#update({ canRetryConversion: false, phase: 'converting' });
      const result = await this.#api.conversionStart(
        this.#scope,
        this.#source,
        this.#snapshot.taskId ?? undefined,
      );
      if (!result.ok) {
        this.#conversionFailure(result.error);
        return;
      }
      if (this.#applyConversion(result.data)) {
        await this.#prepare();
        await this.#autoExecute();
      }
    });
  };
  /** 현재 변환 요청만 중단하며 서버에 보관한 원본·결과와 이전 시도는 남깁니다. */
  stopConversion = async (): Promise<void> => {
    const conversion = this.#snapshot.conversion;
    if (
      !conversion ||
      conversion.state !== 'running' ||
      !this.#api.conversionCancel
    )
      return;
    await this.#run(async (): Promise<void> => {
      this.#restored = true;
      this.#preparationRequested = false;
      this.#autoExecuted = true;
      const cancel = this.#api.conversionCancel;
      if (!cancel) return;
      const result = await cancel(
        this.#scope,
        this.#source,
        conversion.requestId,
        this.#snapshot.taskId ?? undefined,
      );
      if (!result.ok) this.#fail(result.error);
      else this.#applyConversion(result.data);
    });
  };
  /** 중단·응답 유실은 같은 기록을 읽고 미완료 준비 단계만 이어갑니다. */
  async #refresh(): Promise<void> {
    if (this.#restored && this.#snapshot.taskId && this.#api.readTask) {
      const result = await this.#api.readTask(
        this.#scope,
        this.#snapshot.taskId,
      );
      if (!result.ok) this.#fail(result.error);
      else this.#restore(result.data);
      return;
    }
    if (this.#jobId) {
      await this.#inspect();
      return;
    }
    if (this.#registrationUnconfirmed) {
      await this.#prepare();
      return;
    }
    if (['md', 'txt'].includes(this.#registered.item.format)) {
      await this.#prepare();
      return;
    }
    const result = await this.#api.conversionRead(
      this.#scope,
      this.#source,
      this.#snapshot.taskId ?? undefined,
    );
    if (!result.ok) {
      this.#fail(result.error);
      return;
    }
    if (this.#applyConversion(result.data)) await this.#prepare();
  }
  /** 자동 폴링과 사용자 새로고침은 같은 진행 잠금을 공유합니다. */
  refresh = async (): Promise<void> => {
    await this.#run(async (): Promise<void> => {
      await this.#refresh();
      // 변환이 끝나 준비가 이어진 경우에도 등록 요청의 자동 추출을 한 번 잇습니다.
      if (this.#preparationRequested) await this.#autoExecute();
    });
  };
  /** 원래 범위로 돌아온 경우 GET 검증만으로 접근 잠금을 풀며 새 쓰기는 시작하지 않습니다. */
  revalidateScope = async (): Promise<void> => {
    if (this.#snapshot.busy) return;
    this.#update({ scopeInvalid: false, error: null });
    await this.refresh();
  };
  /** 등록 요청이 곧 명시 실행이므로 준비가 끝나면 한 번만 관계 추출을 자동으로 이어갑니다. */
  async #autoExecute(): Promise<void> {
    if (this.#autoExecuted || !this.#snapshot.canExecute) return;
    this.#autoExecuted = true;
    await this.#execute();
  }
  /** 매 실행 직전에 최신 서버 판정과 revision을 재확인합니다. */
  async #execute(): Promise<void> {
    await this.#inspect();
    const detail = this.#snapshot.detail;
    if (
      !this.#snapshot.canExecute ||
      !this.#mode ||
      !this.#jobId ||
      !detail ||
      this.#snapshot.scopeInvalid
    )
      return;
    this.#update({
      canExecute: false,
      phase: 'running',
      message: '관계를 추출하고 있습니다. 저장 결과를 확인하고 있습니다.',
    });
    const result = await this.#api.executeJob(
      this.#scope,
      this.#jobId,
      detail.job.job_revision,
      this.#mode,
    );
    if (!result.ok) {
      this.#fail(result.error);
      return;
    }
    this.#applyDetail(result.data);
  }
  /** 명시 재시작은 확정 실패만 재실행하고, 미확정 요청은 같은 영수증부터 확인합니다. */
  restart = async (): Promise<void> => {
    if (this.#snapshot.busy || this.#snapshot.scopeInvalid) return;
    if (this.#snapshot.canRetryConversion) {
      await this.retryConversion();
      return;
    }
    if (this.#snapshot.canPrepare) {
      await this.begin();
      return;
    }
    const executed = this.#autoExecuted;
    await this.refresh();
    if (executed && this.#snapshot.canExecute) await this.execute();
  };
  /** 사용자가 남은 추출을 다시 누르는 경우에도 같은 확인 절차를 거칩니다. */
  execute = async (): Promise<void> => {
    if (!this.#snapshot.canExecute || !this.#jobId) return;
    await this.#run((): Promise<void> => this.#execute());
  };
}
