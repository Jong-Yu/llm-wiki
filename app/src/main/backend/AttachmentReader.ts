import { constants, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import type {
  AttachmentPickRequest,
  AttachmentPickResult,
} from '@contracts/attachments.contract';
import { defaultRuntime } from './QuestionRunService';
import type { QuestionRuntime } from './QuestionRunService';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  runPersonalCommand,
} from './personalProcess';
import type { PrivateExecution } from './personalProcess';

const EXTENSIONS = [
  'docx',
  'xlsx',
  'pdf',
  'md',
  'txt',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'webp',
];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** OCR이 필요한 스캔 문서를 고려한 상한입니다. 넘으면 읽던 것을 멈추고 알립니다. */
const READ_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

const MESSAGES: Record<string, string> = {
  unsupported_format:
    '지원하지 않는 파일 형식이에요. DOCX, XLSX, PDF, MD, TXT, 그림 파일을 고를 수 있어요.',
  file_too_large: '파일이 너무 커요. 20MB 이하 파일을 골라 주세요.',
  attachment_limit: '남은 첨부 공간에 파일의 첫 글자를 담을 수 없어요.',
  file_unreadable:
    '파일을 읽지 못했어요. 파일이 손상됐거나 암호가 걸려 있을 수 있어요.',
  no_text_found:
    '읽을 수 있는 글자가 없어요. 스캔한 문서나 그림이면 글자 인식 도구(Tesseract) 설치가 필요해요.',
  read_timeout: '파일을 읽는 데 너무 오래 걸려 멈췄어요.',
  read_unavailable:
    '파일을 읽는 도구를 시작하지 못했어요. 설정의 AI 실행에서 프로그램 위치를 확인해 주세요.',
};
const outputSchema = z.union([
  z.object({
    protocol: z.literal('attach-file-cli-v1'),
    ok: z.literal(true),
    text: z.string(),
    total_chars: z.number().int().nonnegative(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  z.object({
    protocol: z.literal('attach-file-cli-v1'),
    ok: z.literal(false),
    error: z.object({ code: z.string() }),
  }),
]);

function failure(code: string): AttachmentPickResult {
  return {
    ok: false,
    error: {
      code,
      message: MESSAGES[code] ?? MESSAGES['read_unavailable'] ?? '',
    },
  };
}

/** 선택하거나 끌어다 놓은 파일 하나를 개인 PC에서 글자로 읽어 돌려줍니다. */
export class AttachmentReader {
  readonly #runtime: () => Promise<QuestionRuntime>;
  readonly #choose: (parent: BrowserWindow) => Promise<string | null>;
  #reading = false;

  constructor(
    runtime: () => Promise<QuestionRuntime> = defaultRuntime,
    choose: (parent: BrowserWindow) => Promise<string | null> = chooseFile,
  ) {
    this.#runtime = runtime;
    this.#choose = choose;
  }

  /** 대화상자가 열려 있는 동안에도 다른 선택·드롭 읽기를 막습니다. */
  pick(
    parent: BrowserWindow,
    request: AttachmentPickRequest,
  ): Promise<AttachmentPickResult> {
    return this.#read(
      (): Promise<string | null> => this.#choose(parent),
      request,
    );
  }

  /** preload에서 확인한 파일에 선택 대화상자와 같은 읽기·정리 경계를 적용합니다. */
  drop(
    path: string,
    request: AttachmentPickRequest,
  ): Promise<AttachmentPickResult> {
    return this.#read((): string => path, request);
  }

  async #read(
    select: () => string | Promise<string | null>,
    request: AttachmentPickRequest,
  ): Promise<AttachmentPickResult> {
    if (this.#reading) return failure('read_unavailable');
    this.#reading = true;
    let source: FileHandle | undefined;
    let execution: PrivateExecution | null = null;
    try {
      const chosen = await select();
      if (chosen === null) return { ok: true, data: null };
      const extension = extname(chosen).slice(1).toLowerCase();
      if (!EXTENSIONS.includes(extension)) return failure('unsupported_format');
      // 권한을 받은 경로를 한 번만 열어 검사와 복사 사이에 교체된 다른 파일을 따라가지 않습니다.
      source = await open(chosen, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await source.stat();
      if (!info.isFile()) return failure('file_unreadable');
      if (info.size > MAX_FILE_BYTES) return failure('file_too_large');
      const runtime = await this.#runtime();
      await assertPersonalRuntime(runtime);
      // 서버에 접속하지 않으므로 인증정보 자리에는 자리표시 값을 둡니다.
      execution = await createPrivateExecution(
        runtime,
        runtime.privateRoot,
        'unused',
      );
      // 원본은 읽기만 하고 앱 전용 작업 폴더의 사본을 변환합니다.
      const copy = join(execution.workDirectory, `attachment.${extension}`);
      const destination = createWriteStream(copy, { flags: 'wx', mode: 0o600 });
      // 검사 후 원본이 커져도 상한 초과를 확인할 한 바이트까지만 복사합니다.
      await pipeline(
        source.createReadStream({ end: MAX_FILE_BYTES }),
        destination,
      );
      if (destination.bytesWritten > MAX_FILE_BYTES)
        return failure('file_too_large');
      const result = await runPersonalCommand(
        runtime,
        [
          '-B',
          '-m',
          'tools.attach_file_cli',
          '--file',
          copy,
          '--extension',
          extension,
          '--limit',
          String(request.limit),
          '--ocr',
          'auto',
          '--ocr-language',
          'kor+eng',
        ],
        { maxBytes: MAX_OUTPUT_BYTES, timeoutMs: READ_TIMEOUT_MS },
      );
      if (result.timedOut) return failure('read_timeout');
      if (result.tooLarge) return failure('read_unavailable');
      const parsed = outputSchema.parse(
        JSON.parse(result.output.trim().split('\n').at(-1) ?? ''),
      );
      if (!parsed.ok) return failure(parsed.error.code);
      // 변환기는 유니코드 문자, 채팅의 남은 공간은 UTF-16 길이로 셉니다.
      const text = parsed.text
        .slice(0, request.limit)
        .replace(/[\uD800-\uDBFF]$/u, '');
      if (!text && parsed.text) return failure('attachment_limit');
      return {
        ok: true,
        data: {
          name: basename(chosen).slice(0, 200),
          text,
          totalChars: parsed.total_chars,
          truncated: parsed.truncated || text.length < parsed.text.length,
          notes: parsed.notes.slice(0, 20),
        },
      };
    } catch {
      return failure('read_unavailable');
    } finally {
      await source?.close().catch((): void => {});
      if (execution) {
        await execution.cleanupAuth().catch((): void => {});
        await rm(execution.directory, { recursive: true, force: true }).catch(
          (): void => {},
        );
      }
      this.#reading = false;
    }
  }
}

/** 앱의 파일 선택 대화상자입니다. 사용자가 고른 경로만 쓰고 취소하면 null입니다. */
async function chooseFile(parent: BrowserWindow): Promise<string | null> {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog(parent, {
    title: '첨부할 파일 선택',
    properties: ['openFile'],
    filters: [
      { name: '문서·표·그림', extensions: EXTENSIONS },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
