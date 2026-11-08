import { matchesExpectedScope } from './readApi';
import { randomUUID } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserWindow, SaveDialogReturnValue } from 'electron';
import {
  desktopMarkdownExportRequestSchema,
  exportExtension,
  markdownExportFilename,
} from '@contracts/fileExports.contract';
import type {
  DesktopMarkdownExportRequest,
  ExportFormat,
  MarkdownExportResult,
} from '@contracts/fileExports.contract';
import type { ConnectionService } from './ConnectionService';
import { ConversionFailed, markdownToDocx } from './DocumentConverter';
import { markdownToPdf } from './PdfRenderer';
import { markdownToPptx, markdownToXlsx } from './documentFormats';

type ExportConnection = Pick<
  ConnectionService,
  'analysisContext' | 'isAnalysisCurrent'
>;
type SaveOutcome = { warning?: string };
type ExportEffects = {
  choose: (
    parent: BrowserWindow,
    filename: string,
    format?: ExportFormat,
  ) => Promise<SaveDialogReturnValue>;
  /** md·txt는 본문 그대로이며 나머지 형식만 변환합니다. 생략하면 내장 변환기를 사용합니다. */
  convert?: (
    format: ExportFormat,
    content: string,
    title: string,
  ) => Promise<string | Uint8Array>;
  save: (
    destination: string,
    content: string | Uint8Array,
    current: () => boolean,
  ) => Promise<SaveOutcome>;
};

/** 연결 변경은 파일 저장 오류와 구별하며 아직 공개하지 않은 임시 파일만 정리합니다. */
class ExportScopeChanged extends Error {}

/** 완성된 임시 파일을 새 경로에만 공개하여 실패나 경쟁 시 기존 파일을 보존합니다. */
export async function saveMarkdownExport(
  destination: string,
  content: string | Uint8Array,
  current: () => boolean,
): Promise<SaveOutcome> {
  const temporary = join(dirname(destination), `.wiki-export-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  let committed = false;
  let cleanupFailed = false;
  try {
    try {
      await (typeof content === 'string'
        ? file.writeFile(content, { encoding: 'utf8' })
        : file.writeFile(content));
      await file.sync();
    } finally {
      await file.close();
    }
    if (!current()) throw new ExportScopeChanged();
    // link는 기존 파일·심볼릭 링크를 교체하지 않으며 완성된 바이트만 공개합니다.
    await link(temporary, destination);
    committed = true;
  } finally {
    await unlink(temporary).catch((): void => {
      cleanupFailed = true;
    });
  }
  return committed && cleanupFailed
    ? { warning: '파일은 저장했지만 임시 내보내기 파일을 정리하지 못했습니다.' }
    : {};
}

/** 사용자 저장 대화상자만 파일 경로를 결정하며 renderer는 경로를 전달하지 않습니다. */
async function chooseMarkdownDestination(
  parent: BrowserWindow,
  filename: string,
  format: ExportFormat = 'md',
): Promise<SaveDialogReturnValue> {
  const { dialog } = await import('electron');
  const label = {
    md: 'Markdown',
    txt: '텍스트',
    docx: 'Word 문서',
    pdf: 'PDF',
    xlsx: 'Excel 통합 문서',
    pptx: 'PowerPoint 프레젠테이션',
  }[format];
  return dialog.showSaveDialog(parent, {
    title: `${label} 파일 저장`,
    defaultPath: filename,
    filters: [{ name: label, extensions: [exportExtension(format)] }],
  });
}

/** 텍스트(md·txt)는 편집본 그대로, 나머지는 변환한 바이트를 돌려줍니다. */
async function defaultConvert(
  format: ExportFormat,
  content: string,
  title: string,
): Promise<string | Uint8Array> {
  if (format === 'docx') return markdownToDocx(content, title);
  if (format === 'pdf') return markdownToPdf(content, title);
  if (format === 'xlsx') return markdownToXlsx(content, title);
  if (format === 'pptx') return markdownToPptx(content, title);
  return content;
}

/** 내보내기 실패는 경로·본문을 반사하지 않는 한정된 결과로 반환합니다. */
function failure(code: string, message: string): MarkdownExportResult {
  return { ok: false, error: { code, message } };
}

/** 같은 편집 범위에서 고른 새 파일에 현재 Markdown 바이트만 저장합니다. */
export class MarkdownExportService {
  readonly #connection: ExportConnection;
  readonly #effects: ExportEffects;
  #exporting = false;

  constructor(
    connection: ExportConnection,
    effects: ExportEffects = {
      choose: chooseMarkdownDestination,
      save: saveMarkdownExport,
    },
  ) {
    this.#connection = connection;
    this.#effects = effects;
  }

  /** 중복 저장 창을 막고 대기 중 연결·호출 창 변경을 쓰기 직전까지 확인합니다. */
  async exportMarkdown(
    request: DesktopMarkdownExportRequest,
    parent: BrowserWindow,
    senderCurrent: () => boolean,
  ): Promise<MarkdownExportResult> {
    const parsed = desktopMarkdownExportRequestSchema.safeParse(request);
    if (!parsed.success)
      return failure(
        'invalid_request',
        '내려받을 제목·본문과 작업 공간을 확인해 주세요.',
      );
    if (this.#exporting)
      return failure(
        'export_in_progress',
        '이미 열린 Markdown 저장 창을 먼저 완료해 주세요.',
      );
    this.#exporting = true;
    const format = parsed.data.format ?? 'md';
    const changed = (): MarkdownExportResult =>
      failure(
        'scope_changed',
        '화면이나 연결 범위가 변경되어 파일 저장을 중단했습니다.',
      );
    try {
      const context = await this.#connection.analysisContext(
        request.connectionId,
      );
      if ('ok' in context)
        return failure(context.error.code, context.error.message);
      if (!matchesExpectedScope(request.expectedScope, context))
        return changed();
      const current = (): boolean =>
        senderCurrent() && this.#connection.isAnalysisCurrent(context);
      if (!current()) return changed();
      const destination = await this.#effects.choose(
        parent,
        markdownExportFilename(request.title, format),
        format,
      );
      if (!current()) return changed();
      if (destination.canceled || !destination.filePath)
        return { ok: true, data: { started: false } };
      // 대화상자를 기다리는 동안 서버에서 회수된 권한도 다시 확인합니다.
      const refreshed = await this.#connection.analysisContext(
        request.connectionId,
      );
      if ('ok' in refreshed)
        return failure(refreshed.error.code, refreshed.error.message);
      if (!current()) return changed();
      // 저장 위치를 고른 뒤 변환합니다. 변환 실패 때는 파일을 만들지 않습니다.
      const converted = await (this.#effects.convert ?? defaultConvert)(
        format,
        request.content,
        request.title,
      );
      if (!current()) return changed();
      const outcome = await this.#effects.save(
        destination.filePath,
        converted,
        current,
      );
      return { ok: true, data: { started: true, ...outcome } };
    } catch (error: unknown) {
      if (error instanceof ExportScopeChanged) return changed();
      if (error instanceof ConversionFailed)
        return failure(
          'conversion_failed',
          '문서를 이 형식으로 변환하지 못했습니다. 저장된 파일은 없으며 Markdown이나 텍스트로 저장할 수 있습니다.',
        );
      return failure(
        'file_save_failed',
        '파일을 저장하지 못했습니다. 기존 파일과 다른 이름 또는 위치를 선택해 주세요. 편집 내용은 유지됩니다.',
      );
    } finally {
      this.#exporting = false;
    }
  }
}
