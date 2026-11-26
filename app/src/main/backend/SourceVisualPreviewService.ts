import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  SourceFormat,
  SourcePreviewRequest,
} from '@contracts/documents.contract';
import type { SourceVersion } from '@contracts/sources.contract';
import type {
  SourceVisualPreviewRequest,
  SourceVisualPreviewResult,
  SourceVisualPreviewReleaseResult,
} from '@contracts/sourceVisualPreviews.contract';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import type { NotificationService } from './NotificationService';
import { apiFailure, matchesExpectedScope } from './readApi';
import type { ApiFailure } from './readApi';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  personalRuntimePaths,
  runPersonalCommand,
} from './personalProcess';
import type { PersonalRuntime, PrivateExecution } from './personalProcess';

const metadataSchema = z.object({
  pageCount: z.number().int().min(1).max(100000),
  kind: z.enum(['office', 'image']),
  limited: z.boolean(),
});
const outputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
type Connection = Pick<
  ConnectionService,
  | 'analysisContext'
  | 'isAnalysisCurrent'
  | 'onScopeChanged'
  | 'readSourceVersions'
  | 'readSourceDownload'
>;
type PreviewSession = {
  previewId: string;
  workflowId: string;
  context: AnalysisContext;
  source: SourcePreviewRequest;
  registrationRevision: string;
  execution: PrivateExecution;
  metadata: z.infer<typeof metadataSchema>;
};
type Options = { workRoot: string; runtime?: PersonalRuntime };
const messages: Record<string, string> = {
  office_preview_unavailable:
    '이 PC에 LibreOffice가 없어 Office 원본을 표시할 수 없습니다. 원본 파일을 열어 확인해 주세요.',
  legacy_office_preview_unavailable:
    '이 PC에서는 구형 PPT 미리보기를 지원하지 않습니다. 원본을 열어 확인하거나 PPTX 파일로 다시 등록해 주세요.',
  office_preview_failed:
    'Office 원본을 표시하지 못했습니다. 원본 파일을 열어 확인해 주세요.',
  preview_page_count_mismatch:
    '원본 슬라이드 수와 미리보기 결과가 달라 표시하지 못했습니다.',
  preview_page_not_found: '해당 원본 페이지를 찾을 수 없습니다.',
  preview_document_too_complex:
    '이 원본은 미리보기 처리 범위를 초과했습니다. 원본 파일을 열어 확인해 주세요.',
  source_changed: '원본 판본이 변경되었습니다. 문서를 다시 열어 주세요.',
  scope_changed: '작업 공간이나 연결이 변경되었습니다.',
  preview_cancelled: '원본 미리보기를 닫았습니다.',
};

/** 원본 사본과 렌더 파일은 현재 화면의 보호 폴더에만 두고 범위 변경·닫기에 회수합니다. */
export class SourceVisualPreviewService {
  readonly #connection: Connection;
  readonly #notifications: Pick<NotificationService, 'read'>;
  readonly #options: Options;
  #session: PreviewSession | null = null;
  #active: { previewId: string; controller: AbortController } | null = null;
  #queue: Promise<void> = Promise.resolve();
  #epoch = 0;
  #serial = 0;
  #latestPreview: string | null = null;

  constructor(
    connection: Connection,
    notifications: Pick<NotificationService, 'read'>,
    options: Options,
  ) {
    this.#connection = connection;
    this.#notifications = notifications;
    this.#options = options;
    connection.onScopeChanged((): void => {
      void this.stop();
    });
  }

  /** 같은 임시 폴더의 준비·렌더·삭제를 순서대로 실행합니다. */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      (): void => {},
      (): void => {},
    );
    return result;
  }

  /** 이번 서비스가 생성한 폴더만 삭제하며 기존 원본·이력에는 접근하지 않습니다. */
  async #clear(): Promise<void> {
    const session = this.#session;
    if (!session) return;
    await rm(session.execution.directory, { recursive: true, force: true });
    this.#session = null;
  }

  /** 연결 종료는 실행 트리 종료 후 보호된 임시 원본까지 회수합니다. */
  async stop(): Promise<void> {
    this.#epoch += 1;
    this.#active?.controller.abort();
    await this.#enqueue(async (): Promise<void> => {
      await this.#clear();
    });
  }

  /** 이전 화면의 늦은 닫기는 다른 미리보기를 취소하거나 지우지 않습니다. */
  release(previewId: string): Promise<SourceVisualPreviewReleaseResult> {
    if (this.#latestPreview === previewId) this.#serial += 1;
    if (this.#active?.previewId === previewId) this.#active.controller.abort();
    return this.#enqueue(
      async (): Promise<SourceVisualPreviewReleaseResult> => {
        try {
          if (this.#session?.previewId === previewId) await this.#clear();
          return { ok: true };
        } catch {
          return apiFailure(
            'preview_cleanup_failed',
            '임시 미리보기를 정리하지 못했습니다.',
          );
        }
      },
    );
  }

  /** 새 페이지 요청은 앞선 렌더를 취소하고 늦은 결과의 화면 공개를 차단합니다. */
  read(
    request: SourceVisualPreviewRequest,
  ): Promise<SourceVisualPreviewResult> {
    const serial = ++this.#serial;
    this.#latestPreview = request.previewId;
    this.#active?.controller.abort();
    const epoch = this.#epoch;
    return this.#enqueue(async (): Promise<SourceVisualPreviewResult> => {
      if (epoch !== this.#epoch)
        return apiFailure('scope_changed', messages.scope_changed);
      if (serial !== this.#serial)
        return apiFailure('preview_cancelled', messages.preview_cancelled);
      const controller = new AbortController();
      this.#active = { previewId: request.previewId, controller };
      try {
        const result = await this.#read(request, controller);
        if (!result.ok && result.error.code !== 'preview_page_not_found')
          await this.#clear();
        return result;
      } catch (error: unknown) {
        await this.#clear().catch((): void => {});
        const code = controller.signal.aborted
          ? 'preview_cancelled'
          : error instanceof Error && messages[error.message]
            ? error.message
            : 'source_preview_failed';
        return apiFailure(
          code,
          messages[code] ??
            '원본 미리보기를 만들지 못했습니다. 원본 파일을 열어 확인해 주세요.',
        );
      } finally {
        this.#active = null;
      }
    });
  }

  /** 고정 원본과 현재 카탈로그를 렌더 전후 확인합니다. */
  async #check(session: PreviewSession): Promise<ApiFailure | null> {
    if (!this.#connection.isAnalysisCurrent(session.context))
      return apiFailure('scope_changed', messages.scope_changed);
    const result = await this.#connection.readSourceVersions({
      connectionId: session.source.connectionId,
      sourceId: session.source.sourceId,
    });
    if (!result.ok) return result;
    if (!this.#connection.isAnalysisCurrent(session.context))
      return apiFailure('scope_changed', messages.scope_changed);
    if (
      result.data.currentVersion !== session.source.sourceVersion ||
      result.data.registrationRevision !== session.registrationRevision ||
      !result.data.versions.some(
        (version: SourceVersion): boolean =>
          version.sourceVersion === session.source.sourceVersion &&
          version.sourceSha256 === session.source.sourceSha256,
      )
    )
      return apiFailure('source_changed', messages.source_changed);
    return null;
  }

  /** 실행기는 로컬 파일 위치만 받고 인증정보·서버 주소를 전달받지 않습니다. */
  async #run(
    runtime: PersonalRuntime,
    work: string,
    format: SourceFormat,
    operation: 'prepare' | 'render',
    controller: AbortController,
    page: number,
  ): Promise<unknown> {
    const result = await runPersonalCommand(
      runtime,
      [
        '-B',
        '-m',
        'tools.source_preview_cli',
        operation,
        '--work-dir',
        work,
        '--format',
        format,
        '--page',
        String(page),
      ],
      { maxBytes: 16384, timeoutMs: 120_000, signal: controller.signal },
    );
    if (result.timedOut || result.tooLarge)
      throw new Error('source_preview_failed');
    const output = outputSchema.parse(JSON.parse(result.output));
    if (!output.ok) throw new Error(output.code);
    if (result.exitCode !== 0) throw new Error('source_preview_failed');
    return output.data;
  }

  async #read(
    request: SourceVisualPreviewRequest,
    controller: AbortController,
  ): Promise<SourceVisualPreviewResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
      false,
    );
    if ('ok' in context) return context;
    if (!matchesExpectedScope(request.expectedScope, context))
      return apiFailure('scope_changed', messages.scope_changed);
    const runtime = this.#options.runtime ?? personalRuntimePaths();
    let session = this.#session;
    if (
      session &&
      (session.previewId !== request.previewId ||
        session.workflowId !== request.workflowId ||
        !this.#connection.isAnalysisCurrent(session.context))
    ) {
      await this.#clear();
      session = null;
    }
    if (!session) {
      const detail = await this.#notifications.read(request);
      if (!detail.ok) return detail;
      const ref = detail.data.workflow.source_ref;
      const catalog = await this.#connection.readSourceVersions({
        connectionId: request.connectionId,
        sourceId: ref.source_id,
      });
      if (!catalog.ok) return catalog;
      const version = catalog.data.versions.find(
        (item: SourceVersion): boolean =>
          item.sourceVersion === ref.source_version &&
          item.sourceSha256 === ref.source_sha256,
      );
      if (
        !version ||
        catalog.data.currentVersion !== ref.source_version ||
        catalog.data.registrationRevision !== ref.registration_revision
      )
        return apiFailure('source_changed', messages.source_changed);
      if (['pdf', 'md', 'txt'].includes(version.format))
        return apiFailure(
          'preview_format_unsupported',
          '이 형식은 기존 원본 보기에서 확인해 주세요.',
        );
      const source: SourcePreviewRequest = {
        connectionId: request.connectionId,
        sourceId: ref.source_id,
        sourceVersion: ref.source_version,
        sourceSha256: ref.source_sha256,
        sizeBytes: version.sizeBytes,
        format: version.format,
      };
      const original = await this.#connection.readSourceDownload(source);
      if (!original.ok) return original;
      if (
        controller.signal.aborted ||
        !this.#connection.isAnalysisCurrent(context)
      )
        throw new Error('scope_changed');
      await assertPersonalRuntime(runtime);
      const execution = await createPrivateExecution(
        runtime,
        this.#options.workRoot,
        '',
      );
      try {
        await execution.cleanupAuth();
        await writeFile(
          join(execution.workDirectory, `source.${source.format}`),
          original.data.bytes,
          { mode: 0o600, flag: 'wx' },
        );
        await writeFile(
          join(execution.directory, 'preview-owner.json'),
          JSON.stringify({
            version: 1,
            previewId: request.previewId,
            sourceId: source.sourceId,
            sourceVersion: source.sourceVersion,
            sourceSha256: source.sourceSha256,
          }),
          { mode: 0o600, flag: 'wx' },
        );
        const metadata = metadataSchema.parse(
          await this.#run(
            runtime,
            execution.workDirectory,
            source.format,
            'prepare',
            controller,
            request.page,
          ),
        );
        session = {
          previewId: request.previewId,
          workflowId: request.workflowId,
          context,
          source,
          registrationRevision: ref.registration_revision,
          execution,
          metadata,
        };
        this.#session = session;
      } catch (error: unknown) {
        await rm(execution.directory, { recursive: true, force: true });
        throw error;
      }
    }
    const before = await this.#check(session);
    if (before) {
      await this.#clear();
      return before;
    }
    if (request.page > session.metadata.pageCount)
      return apiFailure(
        'preview_page_not_found',
        messages.preview_page_not_found,
      );
    await this.#run(
      runtime,
      session.execution.workDirectory,
      session.source.format,
      'render',
      controller,
      request.page,
    );
    const after = await this.#check(session);
    if (after) {
      await this.#clear();
      return after;
    }
    const bytes = await readFile(
      join(session.execution.workDirectory, 'page.png'),
    );
    if (
      bytes.length > 8 * 1024 * 1024 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error('source_preview_failed');
    if (
      controller.signal.aborted ||
      !this.#connection.isAnalysisCurrent(context)
    )
      throw new Error('scope_changed');
    return {
      ok: true,
      data: {
        previewId: request.previewId,
        page: request.page,
        ...session.metadata,
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      },
    };
  }
}
