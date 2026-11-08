import {
  markdownExportRequestSchema,
  markdownExportResultSchema,
} from '@contracts/fileExports.contract';
import type {
  ExportFormat,
  MarkdownExportRequest,
  MarkdownExportResult,
} from '@contracts/fileExports.contract';

/** 현재 실행 환경이 실제 Markdown 파일 내보내기를 제공하는지 확인합니다. */
export function supportsMarkdownExport(): boolean {
  return typeof window.wiki?.fileExports?.exportMarkdown === 'function';
}

/** 내려받기 형식의 화면 이름입니다. */
export const EXPORT_FORMAT_NAMES: Record<ExportFormat, string> = {
  md: 'Markdown (.md)',
  txt: '텍스트 (.txt)',
  docx: 'Word (.docx)',
  pdf: 'PDF (.pdf)',
  xlsx: 'Excel (.xlsx)',
  pptx: 'PowerPoint (.pptx)',
};

/** 이 실행 환경에서 고를 수 있는 저장 형식입니다. 브리지가 알리지 않으면 Markdown·텍스트만 제공합니다. */
export function availableExportFormats(): readonly ExportFormat[] {
  return window.wiki?.fileExports?.formats ?? ['md', 'txt'];
}

/** 화면은 DOM 다운로드나 파일 경로에 접근하지 않고 제한된 내보내기만 요청합니다. */
export async function exportMarkdownFile(
  request: MarkdownExportRequest,
): Promise<MarkdownExportResult> {
  const bridge = window.wiki?.fileExports;
  if (!bridge)
    return {
      ok: false,
      error: {
        code: 'markdown_export_unavailable',
        message: '현재 실행 환경에서는 Markdown 내려받기를 지원하지 않습니다.',
      },
    };
  return markdownExportResultSchema.parse(
    await bridge.exportMarkdown(markdownExportRequestSchema.parse(request)),
  );
}
