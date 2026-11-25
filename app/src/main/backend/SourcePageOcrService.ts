import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import { apiFailure } from './readApi';
import type { ApiFailure } from './readApi';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  runPersonalCommand,
} from './personalProcess';
import type { PrivateExecution } from './personalProcess';
import { conversionCliEventSchema } from './sourceConversionProtocol';

type SourceReference = {
  source_id: string;
  source_version: string;
  source_sha256: string;
  registration_revision: string;
};
type Options = { workRoot: string; projectRoot?: string; python?: string };
type Connection = Pick<
  ConnectionService,
  'isAnalysisCurrent' | 'onScopeChanged'
>;
export type SourcePageOcrResult =
  | { ok: true; data: { page: number; content: string; warnings: string[] } }
  | ApiFailure;

/** 기존 개인 실행기로 한 쪽의 검토 후보만 만들고 서버 보고·승인은 변경하지 않습니다. */
export class SourcePageOcrService {
  readonly #connection: Connection;
  readonly #options: Options;
  #controller: AbortController | null = null;
  #cancelFile: string | null = null;
  #settled: Promise<void> = Promise.resolve();

  constructor(connection: Connection, options: Options) {
    this.#connection = connection;
    this.#options = options;
    connection.onScopeChanged((): void => {
      void this.stop();
    });
  }

  /** 협력 취소 파일을 먼저 남기고 같은 개인 프로세스 그룹만 종료합니다. */
  async #cancel(): Promise<void> {
    const controller = this.#controller;
    if (this.#cancelFile)
      await writeFile(this.#cancelFile, '', { mode: 0o600 }).catch(
        (): void => {},
      );
    controller?.abort();
  }

  /** 앱 종료·범위 변경은 실행과 인증 정리까지 기다립니다. */
  async stop(): Promise<void> {
    const settled = this.#settled;
    await this.#cancel();
    await settled;
  }

  /** 고정 원본과 정확히 한 쪽의 결과가 일치하는 경우에만 후보 본문을 공개합니다. */
  async run(
    context: AnalysisContext,
    sourceRef: SourceReference,
    page: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<SourcePageOcrResult> {
    if (this.#controller)
      return apiFailure(
        'page_ocr_busy',
        '이미 한 쪽의 문자를 다시 인식하고 있습니다.',
      );
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1_000_000 ||
      !/^[a-f0-9]{32}$/.test(requestId) ||
      !/^[a-f0-9]{32}$/.test(sourceRef.source_id) ||
      !/^[a-f0-9]{32}$/.test(sourceRef.source_version) ||
      !/^[a-f0-9]{64}$/.test(sourceRef.source_sha256) ||
      !/^[a-f0-9]{64}$/.test(sourceRef.registration_revision)
    )
      return apiFailure(
        'invalid_page',
        '고정 원본과 다시 인식할 쪽을 확인해 주세요.',
      );
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure(
        'scope_changed',
        '작업 공간이나 연결이 변경되었습니다.',
      );
    if (signal?.aborted)
      return apiFailure('page_ocr_cancelled', '문자 다시 인식을 취소했습니다.');
    const controller = new AbortController();
    this.#controller = controller;
    let finish: () => void = (): void => {};
    this.#settled = new Promise<void>((done: () => void): void => {
      finish = done;
    });
    const cancel = (): void => {
      void this.#cancel();
    };
    signal?.addEventListener('abort', cancel);
    let execution: PrivateExecution | undefined;
    let result: SourcePageOcrResult = apiFailure(
      'page_ocr_failed',
      '이 쪽의 문자를 다시 인식하지 못했습니다. 원래 문자는 보존되며 직접 수정할 수 있습니다.',
    );
    try {
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
      const runtime = { projectRoot, python };
      await access(python);
      await access(join(projectRoot, 'tools/source_conversion_cli.py'));
      await assertPersonalRuntime(runtime);
      if (controller.signal.aborted) throw new Error('cancelled');
      execution = await createPrivateExecution(
        runtime,
        this.#options.workRoot,
        context.token,
      );
      this.#cancelFile = join(execution.directory, 'cancel');
      if (
        controller.signal.aborted ||
        !this.#connection.isAnalysisCurrent(context)
      )
        throw new Error('cancelled');
      const output = await runPersonalCommand(
        runtime,
        [
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
          sourceRef.source_id,
          '--source-version',
          sourceRef.source_version,
          '--source-sha256',
          sourceRef.source_sha256,
          '--registration-revision',
          sourceRef.registration_revision,
          '--request-id',
          requestId,
          '--token-file',
          execution.tokenFile,
          '--work-dir',
          execution.workDirectory,
          '--cancel-file',
          this.#cancelFile,
          '--page',
          String(page),
          '--ocr',
          'always',
          '--ocr-language',
          'kor+eng',
          '--timeout',
          '120',
          '--idle-timeout',
          '80',
        ],
        {
          maxBytes: 32 * 1024 * 1024,
          timeoutMs: 150_000,
          signal: controller.signal,
        },
      );
      if (!this.#connection.isAnalysisCurrent(context))
        throw new Error('scope_changed');
      if (output.timedOut || output.tooLarge || output.exitCode !== 0)
        throw new Error('converter_failed');
      const events = output.output
        .split('\n')
        .filter((line: string): boolean => !!line.trim())
        .map(
          (line: string): ReturnType<typeof conversionCliEventSchema.parse> =>
            conversionCliEventSchema.parse(JSON.parse(line)),
        );
      const terminals = events.filter(
        (event: ReturnType<typeof conversionCliEventSchema.parse>): boolean =>
          event.type === 'result',
      );
      const terminal = terminals[0];
      if (
        terminals.length !== 1 ||
        !terminal ||
        terminal.type !== 'result' ||
        events[events.length - 1] !== terminal ||
        events.some(
          (event: ReturnType<typeof conversionCliEventSchema.parse>): boolean =>
            event.type === 'error' ||
            (event.type === 'progress' && event.stage === 'submit'),
        ) ||
        terminal.request_id !== requestId ||
        terminal.format !== 'pdf' ||
        terminal.receipt.state !== 'not_submitted' ||
        !['complete', 'partial'].includes(terminal.state) ||
        terminal.source_ref.source_id !== sourceRef.source_id ||
        terminal.source_ref.source_version !== sourceRef.source_version ||
        terminal.source_ref.source_sha256 !== sourceRef.source_sha256 ||
        terminal.source_ref.registration_revision !==
          sourceRef.registration_revision ||
        terminal.conversion?.method !== 'ocr' ||
        terminal.conversion.units.length !== 1
      )
        throw new Error('invalid_converter_output');
      const unit = terminal.conversion.units[0];
      if (
        !unit ||
        unit.unit_id !== `page-${page}` ||
        unit.location.kind !== 'pages' ||
        unit.location.start !== page ||
        unit.location.end !== page ||
        !unit.content.trim() ||
        terminal.conversion.unit_methods[unit.unit_id] !== 'ocr'
      )
        throw new Error('invalid_page_output');
      result = {
        ok: true,
        data: {
          page,
          content: unit.content,
          warnings: [
            ...new Set([
              ...terminal.conversion.warnings,
              ...terminal.conversion.unread_ranges.filter(
                (range: string): boolean =>
                  !range.includes('not_selected_for_page_ocr'),
              ),
            ]),
          ].slice(0, 100),
        },
      };
    } catch {
      if (!this.#connection.isAnalysisCurrent(context))
        result = apiFailure(
          'scope_changed',
          '작업 공간이나 연결이 변경되어 재인식 결과를 사용하지 않았습니다.',
        );
      else if (controller.signal.aborted)
        result = apiFailure(
          'page_ocr_cancelled',
          '문자 다시 인식을 취소했습니다. 원래 문자는 보존됩니다.',
        );
    } finally {
      signal?.removeEventListener('abort', cancel);
      try {
        await execution?.cleanupAuth();
      } catch {
        if (result.ok)
          result.data.warnings = [
            ...result.data.warnings.slice(0, 99),
            'private_auth_cleanup_failed',
          ];
      }
      this.#controller = null;
      this.#cancelFile = null;
      finish();
    }
    // 인증 정리를 기다리는 동안 바뀐 범위나 늦은 취소도 후보 공개 전에 반영합니다.
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure(
        'scope_changed',
        '작업 공간이나 연결이 변경되어 재인식 결과를 사용하지 않았습니다.',
      );
    if (controller.signal.aborted)
      return apiFailure(
        'page_ocr_cancelled',
        '문자 다시 인식을 취소했습니다. 원래 문자는 보존됩니다.',
      );
    return result;
  }
}
