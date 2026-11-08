import { z } from 'zod';
import { workspaceScopeSchema } from './workspace.contract';

export const FILE_EXPORT_CHANNELS = {
  markdown: 'file-exports:markdown',
} as const;

/**
 * 저장 형식입니다. xlsx·pptx는 Markdown의 표·제목에서 새로 만드는 산출물이며 원본 파일의 서식을 복원하는 것이 아닙니다.
 */
export const exportFormatSchema = z.enum([
  'md',
  'txt',
  'docx',
  'pdf',
  'xlsx',
  'pptx',
]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  md: 'md',
  txt: 'txt',
  docx: 'docx',
  pdf: 'pdf',
  xlsx: 'xlsx',
  pptx: 'pptx',
};
/** 형식별 파일 확장자입니다. */
export function exportExtension(format: ExportFormat): string {
  return EXPORT_EXTENSIONS[format];
}

/** 화면에서 검토 중인 Markdown만 내보내며 경로나 임의 파일 쓰기를 받지 않습니다. */
export const markdownExportRequestSchema = z.strictObject({
  title: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value: string): boolean =>
        value.trim().length > 0 &&
        !Array.from(value).some((character: string): boolean => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }),
      '제목에는 제어 문자를 사용할 수 없습니다.',
    ),
  content: z
    .string()
    .max(1024 * 1024)
    .refine(
      (value: string): boolean =>
        new TextEncoder().encode(value).byteLength <= 1024 * 1024,
      '본문은 UTF-8 1 MiB 이내로 입력해 주세요.',
    ),
  /** 생략하면 Markdown입니다(기존 호출 호환). */
  format: exportFormatSchema.optional(),
  connectionId: z.string().min(1).max(4096).optional(),
  expectedScope: workspaceScopeSchema.optional(),
});
/** 저장 대화상자를 기다리는 Electron 요청은 편집 당시의 접근 범위를 고정합니다. */
export const desktopMarkdownExportRequestSchema =
  markdownExportRequestSchema.extend({
    connectionId: z.string().min(1).max(4096),
    expectedScope: workspaceScopeSchema,
  });
export const markdownExportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({
      started: z.boolean(),
      warning: z.string().min(1).max(4096).optional(),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(4096),
    }),
  }),
]);
export type MarkdownExportRequest = z.infer<typeof markdownExportRequestSchema>;
export type DesktopMarkdownExportRequest = z.infer<
  typeof desktopMarkdownExportRequestSchema
>;
export type MarkdownExportResult = z.infer<typeof markdownExportResultSchema>;
export type FileExportsBridge = {
  /** 이 실행 환경에서 시도할 수 있는 저장 형식입니다(변환 도구 유무는 저장 때 안내). */
  formats?: readonly ExportFormat[];
  exportMarkdown: (
    request: MarkdownExportRequest,
  ) => Promise<MarkdownExportResult>;
};

/** 제목은 파일명 제안에만 사용하며 경로 문자와 Windows 예약 이름을 제거합니다. */
export function markdownExportFilename(
  title: string,
  format: ExportFormat = 'md',
): string {
  const safe = title
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  const name = safe || 'result';
  return `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' : ''}${name}.${exportExtension(format)}`;
}
