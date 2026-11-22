import { z } from 'zod';

export const RUNTIME_CHANNELS = { execute: 'runtime:execute' } as const;
export const aiProviderSchema = z.enum(['codex', 'claude']);
export type AiProvider = z.infer<typeof aiProviderSchema>;
export const runtimePathKindSchema = z.enum([
  'root',
  'python',
  'codex',
  'claude',
  'tesseract',
  'tessdata',
]);
export type RuntimePathKind = z.infer<typeof runtimePathKindSchema>;
/** AI 도구의 기본 모델을 쓰는 값이며 이때는 --model 인자를 넘기지 않습니다. */
export const DEFAULT_AI_MODEL = 'default';
/** 'default' 또는 앞이 '-'가 아닌 모델 이름만 허용해 CLI 인자 주입을 막습니다. */
export const aiModelSchema = z
  .string()
  .regex(/^(default|[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99})$/);
const aiModelsShape = {
  codex: aiModelSchema,
  claude: aiModelSchema,
};
export const aiModelsSchema = z.object(aiModelsShape).strict();
const runtimeSettingsShape = {
  root: z.string().max(4096),
  python: z.string().max(4096),
  provider: aiProviderSchema,
  codex: z.string().max(4096),
  claude: z.string().max(4096),
  tesseract: z.string().max(4096),
  tessdata: z.string().max(4096),
};
export const runtimeSettingsSchema = z
  .object({ ...runtimeSettingsShape, models: aiModelsSchema })
  .strict();
/** 모델 필드가 없던 옛 저장 파일을 읽기 위한 형태입니다(없으면 모두 default). */
export const storedRuntimeSettingsSchema = z
  .object({
    ...runtimeSettingsShape,
    models: z
      .object({
        codex: aiModelSchema.default(DEFAULT_AI_MODEL),
        claude: aiModelSchema.default(DEFAULT_AI_MODEL),
      })
      .strict()
      .default({ codex: DEFAULT_AI_MODEL, claude: DEFAULT_AI_MODEL }),
  })
  .strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }).strict(),
  z
    .object({
      operation: z.literal('select-provider'),
      provider: aiProviderSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('select-model'),
      provider: aiProviderSchema,
      model: aiModelSchema,
    })
    .strict(),
  z
    .object({ operation: z.literal('choose'), kind: runtimePathKindSchema })
    .strict(),
  z.object({ operation: z.literal('save') }).strict(),
  z.object({ operation: z.literal('diagnose') }).strict(),
  z.object({ operation: z.literal('discover-cli') }).strict(),
  z.object({ operation: z.literal('connect-cli') }).strict(),
  z.object({ operation: z.literal('check-cli-login') }).strict(),
  z.object({ operation: z.literal('cancel-cli-login') }).strict(),
  /** 로그인 확인과 별개로 선택한 AI를 짧게 한 번 호출해 실제로 응답하는지 봅니다. */
  z.object({ operation: z.literal('test-ai') }).strict(),
  /** Windows Claude 호출을 한 번 관측해 경로·본문 없는 진단 보고서를 만들고 엽니다(D-143). */
  z.object({ operation: z.literal('diagnose-claude') }).strict(),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
const runtimeCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(['ok', 'missing', 'error', 'not_run']),
    detail: z.string(),
    /** 일부 기능(예: 스캔 문서 OCR)에만 필요한 항목입니다. 채팅 같은 핵심 기능을 막지 않습니다. */
    optional: z.boolean().optional(),
  })
  .strict();
export type RuntimeCheck = z.infer<typeof runtimeCheckSchema>;
/** 개인 실행기가 돌려주는 거부 메시지 이름표의 형식입니다. 다른 문자열은 받지 않습니다. */
export const aiCliEventSchema = z
  .string()
  .regex(/^(system|type):[a-z][a-z0-9_]{0,63}$/u);
export const cliConnectionSchema = z
  .object({
    provider: aiProviderSchema,
    status: z.enum([
      'idle',
      'checking',
      'login_required',
      'waiting_login',
      'connected',
      'error',
    ]),
    message: z.string(),
    code: z.string().nullable(),
    /** 실제 AI 호출로 응답을 확인한 시각입니다. 로그인만 확인했으면 없습니다. */
    verifiedAt: z.string().nullable().optional(),
    /** 호출 확인에서 거부한 AI CLI 메시지의 종류 이름표입니다(예: system:hook_started). 본문은 없습니다. */
    event: aiCliEventSchema.optional(),
  })
  .strict();
export type CliConnection = z.infer<typeof cliConnectionSchema>;
/** 마지막 Claude 진단 보고서의 결과입니다. 보고서에는 경로·계정·응답 본문이 없습니다. */
const diagnosticReportSchema = z
  .object({
    status: z.enum(['saved', 'failed']),
    message: z.string(),
    path: z.string().nullable(),
  })
  .strict();
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;
const runtimeSnapshotSchema = z
  .object({
    settings: runtimeSettingsSchema,
    activeProvider: aiProviderSchema,
    /** 이 앱 실행에 적용된 활성 제공자의 모델입니다. */
    activeModel: aiModelSchema,
    restartRequired: z.boolean(),
    saved: z.boolean(),
    issue: z.string().nullable(),
    checks: z.array(runtimeCheckSchema),
    cliConnection: cliConnectionSchema.optional(),
    diagnosticReport: diagnosticReportSchema.optional(),
    platform: z.string(),
  })
  .strict();
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
const runtimeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: runtimeSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);
export type RuntimeResult = z.infer<typeof runtimeResultSchema>;
export type RuntimeBridge = {
  execute: (request: RuntimeRequest) => Promise<RuntimeResult>;
};
/** 실행 환경 응답의 공개 필드만 통과시킵니다. */
export function parseRuntimeResult(value: unknown): RuntimeResult {
  return runtimeResultSchema.parse(value);
}

/**
 * 개인 실행기가 AI CLI를 부르기 전 준비 단계(프로세스 묶음·비공개 작업 폴더)에서 실패한 고정 코드입니다.
 * CLI 설치·로그인 문제와 다르므로 프로그램 위치 변경이나 재로그인을 안내하지 않습니다.
 */
const AI_RUNTIME_PREPARATION_CODES: ReadonlySet<string> = new Set([
  'ai_process_job_failed',
  'ai_windows_dependency_missing',
  'ai_windows_security_dependency_missing',
  'ai_windows_directory_unavailable',
  'ai_windows_file_unavailable',
  'ai_private_directory_required',
  'ai_private_file_required',
  'ai_unsupported_file_acl',
  'ai_unsafe_file_path',
  'ai_file_changed',
]);

/** 오류 코드가 AI 호출 전 실행 준비 단계의 실패인지 확인합니다. */
export function isAiRuntimePreparationFailure(
  code: string | null | undefined,
): boolean {
  return typeof code === 'string' && AI_RUNTIME_PREPARATION_CODES.has(code);
}
