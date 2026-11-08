import {
  MAX_SOURCE_BYTES,
  parseSourcePreviewRequest,
} from '@contracts/documents.contract';
import {
  parseChooseSourceFileResult,
  parseSourceDownloadResult,
  sourceSessionSchema,
} from '@contracts/sources.contract';
import type {
  ChooseSourceFileResult,
  SourceDownloadResult,
} from '@contracts/sources.contract';
import {
  markdownExportFilename,
  markdownExportRequestSchema,
} from '@contracts/fileExports.contract';
import type {
  MarkdownExportRequest,
  MarkdownExportResult,
} from '@contracts/fileExports.contract';

let choosing = false;
let downloading = false;
let fileEpoch = 0;
const transfers = new Set<AbortController>();
let cancelPicker: (() => void) | null = null;

/** 계정·관점 전환이 시작되면 늦은 파일 선택과 다운로드 완료를 즉시 무효화합니다. */
export function invalidateBrowserFiles(): void {
  fileEpoch += 1;
  for (const controller of transfers) controller.abort();
  cancelPicker?.();
}

/** 사용자가 고른 파일 하나만 반환하며 선택 취소는 기존 폼 상태를 변경하지 않습니다. */
function pickFile(): Promise<File | null> {
  return new Promise<File | null>(
    (resolve: (file: File | null) => void): void => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept =
        '.md,.txt,.pdf,.xlsx,.docx,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff';
      input.setAttribute('aria-label', '업로드할 원본 파일');
      input.hidden = true;
      let settled = false;
      /** 선택 완료나 취소 뒤 파일 input을 남기지 않습니다. */
      function finish(file: File | null): void {
        if (settled) return;
        settled = true;
        cancelPicker = null;
        input.remove();
        resolve(file);
      }
      cancelPicker = (): void => finish(null);
      input.addEventListener(
        'change',
        (): void => finish(input.files?.[0] ?? null),
        { once: true },
      );
      input.addEventListener('cancel', (): void => finish(null), {
        once: true,
      });
      document.body.append(input);
      input.click();
    },
  );
}

/** 바이너리를 JSON/base64로 부풀리지 않고 제한된 원본 선택 경로로 한 번만 전송합니다. */
export async function chooseBrowserSource(
  value: unknown,
): Promise<ChooseSourceFileResult> {
  if (choosing)
    return {
      ok: false,
      error: {
        code: 'registration_busy',
        message: '열려 있는 파일 선택을 먼저 마쳐 주세요.',
      },
    };
  choosing = true;
  const epoch = fileEpoch;
  const controller = new AbortController();
  transfers.add(controller);
  try {
    const request = sourceSessionSchema.parse(value);
    const file = await pickFile();
    if (epoch !== fileEpoch) throw new Error('connection_changed');
    if (!file) return { ok: true, data: null };
    if (file.size > MAX_SOURCE_BYTES)
      return {
        ok: false,
        error: {
          code: 'source_too_large',
          message: '원본 파일은 20 MiB 이내로 선택해 주세요.',
        },
      };
    const response = await fetch('/__wiki_test/source-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Wiki-Test-Request': '1',
        'X-Wiki-File-Metadata': encodeURIComponent(
          JSON.stringify({ request, filename: file.name }),
        ),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      body: file,
    });
    if (!response.ok) throw new Error('upload_failed');
    const result: unknown = await response.json();
    if (epoch !== fileEpoch) throw new Error('connection_changed');
    return parseChooseSourceFileResult(result);
  } catch {
    return {
      ok: false,
      error: {
        code: 'file_selection_failed',
        message:
          '파일 선택 결과를 확인하지 못했습니다. 입력한 제목과 본문은 유지됩니다. 파일을 다시 선택해 주세요.',
      },
    };
  } finally {
    transfers.delete(controller);
    choosing = false;
  }
}

/** 브라우저에 내려받기를 넘긴 결과만 알리고 디스크 저장 완료로 확대하지 않습니다. */
function startDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout((): void => URL.revokeObjectURL(url), 1000);
}

/** 서버와 브라우저 양쪽에서 원본 길이·해시가 맞는지 확인한 뒤 파일로 내보냅니다. */
export async function downloadBrowserSource(
  value: unknown,
): Promise<SourceDownloadResult> {
  if (downloading)
    return {
      ok: false,
      error: {
        code: 'download_busy',
        message: '진행 중인 내려받기를 기다려 주세요.',
      },
    };
  downloading = true;
  const epoch = fileEpoch;
  const controller = new AbortController();
  transfers.add(controller);
  try {
    const request = parseSourcePreviewRequest(value);
    const response = await fetch('/__wiki_test/source-download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wiki-Test-Request': '1',
      },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('download_failed');
    if (response.headers.get('content-type')?.startsWith('application/json')) {
      const result: unknown = await response.json();
      return parseSourceDownloadResult(result);
    }
    if (response.headers.get('x-source-sha256') !== request.sourceSha256)
      throw new Error('download_mismatch');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('download_empty');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > request.sizeBytes || size > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error('download_too_large');
      }
      parts.push(new Uint8Array(chunk.value));
    }
    if (size !== request.sizeBytes) throw new Error('download_mismatch');
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()),
    );
    const hash = Array.from(digest, (byte: number): string =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== request.sourceSha256) throw new Error('download_mismatch');
    if (epoch !== fileEpoch) throw new Error('connection_changed');
    startDownload(blob, `original.${request.format}`);
    return { ok: true, data: { saved: true } };
  } catch {
    return {
      ok: false,
      error: {
        code: 'download_failed',
        message:
          '원본 내려받기를 시작하지 못했습니다. 연결과 원본 판본을 다시 확인해 주세요.',
      },
    };
  } finally {
    transfers.delete(controller);
    downloading = false;
  }
}

/** 현재 편집 본문을 변형 없이 UTF-8 Markdown으로 내보내며 서버 자료를 저장하지 않습니다. */
export async function exportBrowserMarkdown(
  value: MarkdownExportRequest,
): Promise<MarkdownExportResult> {
  const parsed = markdownExportRequestSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: 'invalid_export',
        message: '제목과 1 MiB 이내의 본문을 확인해 주세요.',
      },
    };
  const format = parsed.data.format ?? 'md';
  // 브라우저에는 변환 도구가 없어 DOCX·PDF는 만들지 않습니다.
  if (format !== 'md' && format !== 'txt')
    return {
      ok: false,
      error: {
        code: 'converter_missing',
        message: '이 환경에서는 Markdown과 텍스트로만 내보낼 수 있습니다.',
      },
    };
  try {
    startDownload(
      new Blob([parsed.data.content], {
        type:
          format === 'txt'
            ? 'text/plain;charset=utf-8'
            : 'text/markdown;charset=utf-8',
      }),
      markdownExportFilename(parsed.data.title, format),
    );
    return { ok: true, data: { started: true } };
  } catch {
    return {
      ok: false,
      error: {
        code: 'download_failed',
        message:
          'Markdown 내려받기를 시작하지 못했습니다. 편집 내용은 그대로 유지됩니다.',
      },
    };
  }
}
