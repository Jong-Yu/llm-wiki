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
  })
  .strict();
export type CliConnection = z.infer<typeof cliConnectionSchema>;
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
