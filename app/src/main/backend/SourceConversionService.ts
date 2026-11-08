import { matchesExpectedScope } from './readApi';
import { sameAccessRevision } from '@contracts/connection.contract';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  conversionReportSchema,
  parseSourceConversionResult,
} from '@contracts/sourceConversion.contract';
import type {
  SourceConversionReadRequest,
  SourceConversionStartRequest,
  SourceConversionCancelRequest,
  SourceConversionRun,
  SourceConversionResult,
} from '@contracts/sourceConversion.contract';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import { apiFailure, readApiJson } from './readApi';
import type { ApiFailure } from './readApi';
import { readProcessJournal, writeProcessJournal } from './processRecovery';
import type { ProcessRecovery } from './processRecovery';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import { z } from 'zod';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  spawnPersonalProcess,
  stopPersonalProcess,
} from './personalProcess';
import type { PrivateExecution } from './personalProcess';
import {
  conversionCliEventSchema,
  conversionStoredSchema,
  conversionId,
  matchesConversionSource,
  conversionMessage,
} from './sourceConversionProtocol';

export type SourceConversionServiceOptions = {
  workRoot: string;
  projectRoot?: string;
  python?: string;
};
type StoredRun = {
  context: AnalysisContext;
  value: SourceConversionRun;
  cancelFile: string;
  submitted: boolean;
};
type Running = {
  record: StoredRun;
  child: ChildProcess;
  closed: Promise<void>;
};

/** 원본 판본과 권한 범위를 함께 고정합니다. */
function key(
  context: AnalysisContext,
  request: SourceConversionReadRequest,
): string {
  return JSON.stringify([
    context.active.connectionId,
    context.active.userId,
    context.selection.tenant,
    context.selection.profile,
    context.active.accessRevision ?? context.active.policyRevision,
    request.sourceId,
    request.sourceVersion,
    request.sourceSha256,
    request.registrationRevision,
  ]);
}
/** 명시 실행만 개인 Python 변환기를 시작하고 저장 사실은 별도 GET으로 확인합니다. */
export class SourceConversionService {
  #connection: Pick<
    ConnectionService,
    | 'analysisContext'
    | 'isAnalysisCurrent'
    | 'onScopeChanged'
    | 'analysisAccessFailure'
  >;
  #options: SourceConversionServiceOptions;
  #recovery: ProcessRecovery | undefined;
  #runs = new Map<string, StoredRun>();
  #running: Running | null = null;
  #starting = false;
  #epoch = 0;
  #startSettled: Promise<void> = Promise.resolve();
  #finishStart: (() => void) | undefined;
  #requests = new Set<AbortController>();

  /** 연결 변경은 실행을 중단하지만 기존 원본·변환 파일은 보존합니다. */
  constructor(
    connection: Pick<
      ConnectionService,
      | 'analysisContext'
      | 'isAnalysisCurrent'
      | 'onScopeChanged'
      | 'analysisAccessFailure'
    >,
    options: SourceConversionServiceOptions,
    recovery?: ProcessRecovery,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#recovery = recovery;
    connection.onScopeChanged((): void => {
      for (const request of this.#requests) request.abort();
      void this.stop();
    });
  }

  /** 화면이 준비한 주체와 현재 서버 권한을 실행/조회 직전에 비교합니다. */
  async #context(
    request: SourceConversionReadRequest,
    write: boolean = false,
  ): Promise<AnalysisContext | ApiFailure> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
      write,
    );
    if ('ok' in context) return context;
    if (!matchesExpectedScope(request.expectedScope, context))
      return apiFailure(
        'scope_changed',
        '원본을 선택한 작업 공간 또는 조회 설정이 변경되었습니다. 원본을 다시 선택해 주세요.',
      );
    return context;
  }

  /** 내부 경로/자식 프로세스를 공개 결과에 넣지 않습니다. */
  #result(record?: StoredRun): SourceConversionResult {
    return parseSourceConversionResult({
      ok: true,
      data: record?.value ?? null,
    });
  }

  /** 동일 미확정 요청은 새 변환/저장을 시작하지 않고 조회로 복구합니다. */
  async start(
    request: SourceConversionStartRequest,
  ): Promise<SourceConversionResult> {
    if (this.#starting || this.#running)
      return apiFailure(
        'conversion_busy',
        '이미 이 PC에서 변환 중입니다. 진행 중인 작업을 확인해 주세요.',
      );
    this.#starting = true;
    const epoch = this.#epoch;
    this.#startSettled = new Promise<void>((done: () => void): void => {
      this.#finishStart = done;
    });
    try {
      const context = await this.#context(request, true);
      if ('ok' in context) return context;
      const journal = await this.#restore(context, request);
      const previous = this.#runs.get(key(context, request));
      if (previous?.value.receiptState === 'unconfirmed')
        await this.#confirm(previous);
      if (previous?.value.receiptState === 'unconfirmed')
        return apiFailure(
          'report_unconfirmed',
          '이전 보고의 저장 상태를 먼저 확인해 주세요. 같은 보고를 자동 재전송하지 않습니다.',
        );
      const projectRoot =
        this.#options.projectRoot ??
        process.env.WIKI_CLIENT_ROOT ??
        process.env.WIKI_ANALYSIS_PROJECT_ROOT ??
        resolve(import.meta.dirname, '../../..');
      const python =
        this.#options.python ??
        process.env.WIKI_CLIENT_PYTHON ??
        process.env.WIKI_PYTHON ??
        process.env.WIKI_ANALYSIS_PYTHON ??
        join(
          projectRoot,
          process.platform === 'win32'
            ? '.venv/Scripts/python.exe'
            : '.venv/bin/python',
        );
      try {
        await access(python);
        await access(join(projectRoot, 'tools/source_conversion_cli.py'));
        await assertPersonalRuntime({ projectRoot, python });
      } catch {
        return apiFailure(
          process.platform === 'win32'
            ? 'unsupported_platform'
            : 'converter_unavailable',
          process.platform === 'win32'
            ? 'Windows 개인 실행 환경의 파일 보호·프로세스 종료 진단에 실패했습니다. Python·pywin32 설치와 실행 경로를 확인해 주세요. 기존 변환 보고는 조회할 수 있습니다.'
            : '개인 PC 변환 실행기가 설치되지 않았습니다. Python 클라이언트 환경과 변환 의존성을 설치하고 실행 경로를 확인해 주세요.',
        );
      }
      const runtime = { projectRoot, python };
      const execution = await createPrivateExecution(
        runtime,
        this.#options.workRoot,
        context.token,
      );
      const record: StoredRun = {
        context,
        cancelFile: join(execution.directory, 'cancel'),
        submitted: false,
        value: {
          requestId: randomUUID().replaceAll('-', ''),
          source: {
            sourceId: request.sourceId,
            sourceVersion: request.sourceVersion,
            sourceSha256: request.sourceSha256,
            registrationRevision: request.registrationRevision,
          },
          state: 'running',
          format: null,
          progress: null,
          report: null,
          receiptState: 'pending',
          reference: null,
          message: conversionMessage('running'),
          diagnosticCodes: [],
          cleanupWarning: false,
        },
      };
      try {
        await writeProcessJournal(
          this.#recovery,
          context,
          'pending-source-conversion',
          `source:${request.sourceId}:${request.sourceVersion}`,
          { requestId: record.value.requestId, source: record.value.source },
          journal?.revision ?? null,
        );
        if (
          epoch !== this.#epoch ||
          !this.#connection.isAnalysisCurrent(context)
        )
          throw new Error('scope_changed');
        const args = [
          '-B',
          '-m',
          'tools.source_conversion_cli',
          '--server',
          context.active.serverUrl.replace(/\/api\/v1\/$/, ''),
          '--tenant',
          context.selection.tenant,
          '--profile',
          context.selection.profile,
          '--source-id',
          request.sourceId,
          '--source-version',
          request.sourceVersion,
          '--source-sha256',
          request.sourceSha256,
          '--registration-revision',
          request.registrationRevision,
          '--token-file',
          execution.tokenFile,
          '--work-dir',
          execution.workDirectory,
          '--request-id',
          record.value.requestId,
          '--cancel-file',
          record.cancelFile,
          '--ocr',
          request.ocr,
          '--ocr-language',
          request.ocrLanguage,
          '--submit',
        ];
        const child = spawnPersonalProcess(runtime, args);
        child.stderr?.resume();
        this.#runs.set(key(context, request), record);
        this.#observe(record, child, execution);
        // 완료된 예전 실행 표시만 제한합니다. 미확정 결과와 디스크의 원본은 보존합니다.
        if (this.#runs.size > 20) {
          const old = [...this.#runs].find(
            (entry: [string, StoredRun]): boolean =>
              entry[1] !== record &&
              entry[1].value.receiptState !== 'unconfirmed',
          );
          if (old) this.#runs.delete(old[0]);
        }
        return this.#result(record);
      } catch {
        await execution.cleanupAuth().catch((): void => {
          record.value.cleanupWarning = true;
        });
        return apiFailure(
          'conversion_start_failed',
          '변환 실행기를 시작하지 못했습니다. 설치 경로와 현재 연결을 확인해 주세요.',
        );
      }
    } catch {
      return apiFailure(
        'conversion_start_failed',
        '변환 실행 환경의 설치·보호 기능을 확인하지 못했습니다. 기존 자료는 보존됩니다.',
      );
    } finally {
      this.#starting = false;
      this.#finishStart?.();
      this.#finishStart = undefined;
    }
  }

  /** 제한된 JSONL만 해석하고 CLI의 경로·stderr·원본 바이트는 renderer에 노출하지 않습니다. */
  #observe(
    record: StoredRun,
    child: ChildProcess,
    execution: PrivateExecution,
  ): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let terminal = false;
    let invalid = false;
    /** 한 완성 이벤트를 검사한 뒤 현재 실행 상태에 반영합니다. */
    const consume = (line: string): void => {
      if (!line.trim() || terminal || invalid) return;
      try {
        const event = conversionCliEventSchema.parse(JSON.parse(line));
        if (event.type === 'progress') {
          record.value.progress = {
            stage: event.stage,
            completed: event.completed,
            total: event.total,
            location: event.location,
          };
          if (event.stage === 'submit') record.submitted = true;
        } else if (event.type === 'error') {
          record.value.diagnosticCodes = [event.error.code];
        } else {
          if (
            event.request_id !== record.value.requestId ||
            !matchesConversionSource(record.value.source, event.source_ref)
          )
            throw new Error('wrong_basis');
          terminal = true;
          record.value.format = event.format;
          record.value.report = event.conversion;
          record.value.state =
            event.receipt.state === 'saved' ||
            event.receipt.state === 'unconfirmed'
              ? 'report_unconfirmed'
              : event.receipt.state === 'rejected'
                ? 'failed'
                : event.state;
          record.value.message = conversionMessage(record.value.state);
          if (
            event.state === 'complete' &&
            event.receipt.state === 'not_submitted'
          )
            record.value.message =
              '이 PC에서 변환했지만 보고는 제출하지 않았습니다.';
          record.value.diagnosticCodes = [
            ...new Set([
              ...(event.conversion?.diagnostics.map(
                (diagnostic: { code: string }): string => diagnostic.code,
              ) ?? []),
              ...(event.receipt.error ? [event.receipt.error.code] : []),
              ...(event.error ? [event.error.code] : []),
            ]),
          ].slice(0, 100);
          // saved 자체는 개인 실행기 보고이며 main의 GET 대조 전에는 미확인입니다.
          record.value.receiptState =
            event.receipt.state === 'saved'
              ? 'unconfirmed'
              : event.receipt.state;
        }
      } catch {
        invalid = true;
        record.value.diagnosticCodes = ['invalid_converter_output'];
        void this.#signalCancel(record, child);
      }
    };
    child.stdout?.on('data', (chunk: Buffer): void => {
      if (invalid) return;
      buffer += decoder.write(chunk);
      // UTF-8 4 MiB의 JSON escape와 진단 여유를 포함하는 한 이벤트 상한입니다.
      if (buffer.length > 32 * 1024 * 1024) {
        invalid = true;
        buffer = '';
        record.value.diagnosticCodes = ['converter_output_limit'];
        void this.#signalCancel(record, child);
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    const running: Running = { record, child, closed: Promise.resolve() };
    running.closed = new Promise<void>((done: () => void): void => {
      child.on('error', (): void => {
        record.value.diagnosticCodes = ['converter_unavailable'];
      });
      child.on('close', (): void => {
        buffer += decoder.end();
        consume(buffer);
        if (!terminal) {
          record.value.state = record.submitted
            ? 'report_unconfirmed'
            : 'failed';
          record.value.receiptState = record.submitted
            ? 'unconfirmed'
            : 'not_submitted';
          record.value.message = conversionMessage(record.value.state);
        }
        void execution
          .cleanupAuth()
          .catch((): void => {
            record.value.cleanupWarning = true;
          })
          .then(async (): Promise<void> => {
            if (
              this.#connection.isAnalysisCurrent(record.context) &&
              record.value.receiptState === 'unconfirmed'
            )
              await this.#confirm(record);
          })
          .finally((): void => {
            if (this.#running === running) this.#running = null;
            done();
          });
      });
    });
    this.#running = running;
  }

  /** 보고 조회는 현재 권한·주체·고정 원본·구성 텍스트를 다시 검사하고 POST하지 않습니다. */
  async #confirm(record: StoredRun): Promise<void> {
    const context = record.context;
    if (!this.#connection.isAnalysisCurrent(context)) return;
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      const reportId = conversionId(
        context.selection.tenant,
        context.active.userId,
        record.value.requestId,
      );
      const url = new URL(
        `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/analysis-conversions/${reportId}`,
      );
      url.searchParams.set('profile', context.selection.profile);
      const response = await readApiJson(url.href, context.token, controller, {
        maxResponseBytes: 32 * 1024 * 1024,
      });
      if (!this.#connection.isAnalysisCurrent(context)) return;
      if (!response.ok) {
        this.#connection.analysisAccessFailure(response);
        record.value.state = 'report_unconfirmed';
        record.value.message = conversionMessage('report_unconfirmed');
        return;
      }
      const { data } = conversionStoredSchema.parse(response.value);
      const manifest = data.manifest;
      if (
        manifest.id !== reportId ||
        manifest.request_id !== record.value.requestId ||
        manifest.user_id !== context.active.userId ||
        manifest.tenant !== context.selection.tenant ||
        !matchesConversionSource(record.value.source, manifest.source_ref) ||
        data.access.user_id !== context.active.userId ||
        data.access.tenant !== context.selection.tenant ||
        data.access.profile_id !== context.selection.profile ||
        !sameAccessRevision(
          {
            policyRevision: data.access.policy_revision,
            accessRevision: data.access.access_revision,
          },
          context.active,
        )
      )
        throw new Error('invalid_receipt');
      const report = conversionReportSchema.parse({
        ...manifest,
        diagnostics: record.value.report?.diagnostics ?? [],
        unit_methods: record.value.report?.unit_methods ?? {},
        units: manifest.units.map(
          (
            unit: (typeof manifest.units)[number],
          ): {
            unit_id: string;
            location: (typeof unit)['location'];
            content: string | undefined;
          } => ({ ...unit, content: data.components[unit.unit_id] }),
        ),
      });
      record.value.report = report;
      record.value.receiptState = 'saved';
      record.value.reference = {
        ...record.value.source,
        conversionId: reportId,
        conversionRevision: data.revision,
        requestId: record.value.requestId,
      };
      record.value.state = report.complete ? 'complete' : 'partial';
      record.value.message = conversionMessage(record.value.state);
    } catch {
      record.value.state = 'report_unconfirmed';
      record.value.message = conversionMessage('report_unconfirmed');
    } finally {
      this.#requests.delete(controller);
    }
  }

  /** 보관된 실행 ID는 서버 보고의 GET 복구에만 사용하며 로컬 경로와 토큰은 복원하지 않습니다. */
  async #restore(
    context: AnalysisContext,
    request: SourceConversionReadRequest,
  ): Promise<RecoveryEntry | null> {
    const entries = await readProcessJournal(
      this.#recovery,
      context,
      'pending-source-conversion',
    );
    const entry = entries.find(
      (value: RecoveryEntry): boolean =>
        value.key === `source:${request.sourceId}:${request.sourceVersion}`,
    );
    if (!entry) return null;
    const value = z
      .object({
        requestId: z.string().regex(/^[a-f0-9]{32}$/),
        source: z.object({
          sourceId: z.string(),
          sourceVersion: z.string(),
          sourceSha256: z.string(),
          registrationRevision: z.string(),
        }),
      })
      .parse(JSON.parse(entry.payload));
    if (
      value.source.sourceId !== request.sourceId ||
      value.source.sourceVersion !== request.sourceVersion ||
      value.source.sourceSha256 !== request.sourceSha256 ||
      value.source.registrationRevision !== request.registrationRevision
    )
      throw new Error('recovery_basis_changed');
    if (!this.#runs.has(key(context, request)))
      this.#runs.set(key(context, request), {
        context,
        cancelFile: '',
        submitted: true,
        value: {
          requestId: value.requestId,
          source: value.source,
          state: 'report_unconfirmed',
          format: null,
          progress: null,
          report: null,
          receiptState: 'unconfirmed',
          reference: null,
          message: conversionMessage('report_unconfirmed'),
          diagnosticCodes: [],
          cleanupWarning: false,
        },
      });
    return entry;
  }

  /** 조회는 프로세스를 시작하지 않으며 미확정 보고만 동일 ID로 다시 확인합니다. */
  async read(
    request: SourceConversionReadRequest,
  ): Promise<SourceConversionResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    try {
      await this.#restore(context, request);
    } catch {
      return apiFailure(
        'recovery_unavailable',
        '변환 요청 기록을 복원하지 못했습니다. 기존 보호 자료는 보존됩니다.',
      );
    }
    const record = this.#runs.get(key(context, request));
    if (
      record?.value.receiptState === 'unconfirmed' &&
      this.#running?.record !== record
    )
      await this.#confirm(record);
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure('scope_changed', '조회 중 연결이 변경되었습니다.');
    return this.#result(record);
  }

  /** 취소 파일은 Python이 작업자 트리를 정리하도록 하는 OS 공통 신호입니다. */
  async #signalCancel(record: StoredRun, child: ChildProcess): Promise<void> {
    try {
      await writeFile(record.cancelFile, 'cancel\n', {
        mode: 0o600,
        flag: 'wx',
      });
    } catch {
      child.stdin?.write('{"type":"cancel"}\n');
    }
    if (this.#running?.child === child)
      void stopPersonalProcess(child, this.#running.closed);
  }

  /** 로컬 취소는 원본이나 이미 저장된 보고를 삭제하지 않습니다. */
  async cancel(
    request: SourceConversionCancelRequest,
  ): Promise<SourceConversionResult> {
    const context = await this.#context(request);
    if ('ok' in context) return context;
    const record = this.#runs.get(key(context, request));
    if (!record || record.value.requestId !== request.requestId)
      return apiFailure(
        'conversion_not_found',
        '현재 원본의 변환 요청을 찾을 수 없습니다.',
      );
    if (this.#running?.record === record) {
      record.value.state = 'cancelling';
      record.value.message = conversionMessage('cancelling');
      await this.#signalCancel(record, this.#running.child);
    }
    return this.#result(record);
  }

  /** 앱 종료·권한 변경 때만 종료를 기다리고 임시 인증 파일 정리를 완료합니다. */
  async stop(): Promise<void> {
    this.#epoch += 1;
    await this.#startSettled;
    const running = this.#running;
    if (!running) return;
    await this.#signalCancel(running.record, running.child);
    await stopPersonalProcess(running.child, running.closed);
  }
}
