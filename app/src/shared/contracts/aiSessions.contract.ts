import { z } from 'zod';

export const AI_SESSIONS_CHANNELS = { read: 'ai-sessions:read' } as const;
export const aiSessionsRequestSchema = z.strictObject({
  connectionId: z.string().min(1),
  refreshUsage: z.boolean().optional(),
});
export const aiActivitySchema = z.object({
  kind: z.enum(['analysis', 'question', 'proposal', 'comparison']),
  id: z.string(),
  connectionId: z.string(),
  status: z.enum(['starting', 'running', 'stopping']),
  startedAt: z.string(),
  document: z.string().optional(),
  conversationId: z.string().optional(),
  proposalId: z.string().optional(),
});
export const accountUsageSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  status: z.enum(['available', 'unavailable', 'error']),
  accountLabel: z.string().nullable(),
  checkedAt: z.string().nullable(),
  stale: z.boolean(),
  windows: z.array(
    z.object({
      name: z.string(),
      usedPercent: z.number().min(0),
      remainingPercent: z.number().min(0).max(100),
      windowMinutes: z.number().nullable(),
      resetsAt: z.string().nullable(),
    }),
  ),
  message: z.string().nullable(),
});
const resultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    data: z.object({
      activities: z.array(aiActivitySchema),
      usage: accountUsageSchema,
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      status: z.number().optional(),
      traceId: z.string().optional(),
    }),
  }),
]);
export type AiActivity = z.infer<typeof aiActivitySchema>;
export type AccountUsage = z.infer<typeof accountUsageSchema>;
export type AiSessionsRequest = z.infer<typeof aiSessionsRequestSchema>;
export type AiSessionsResult = z.infer<typeof resultSchema>;
export type AiSessionsBridge = {
  read: (request: AiSessionsRequest) => Promise<AiSessionsResult>;
};
/** 외부 전송 값을 확인한 뒤에만 활동·한도 상태를 표시합니다. */
export function parseAiSessionsResult(value: unknown): AiSessionsResult {
  return resultSchema.parse(value);
}

export type AiSessionsReadRequest = AiSessionsRequest;
export type AiSessionsSnapshot = Extract<
  AiSessionsResult,
  { ok: true }
>['data'];
export type AccountUsageWindow = AccountUsage['windows'][number];
