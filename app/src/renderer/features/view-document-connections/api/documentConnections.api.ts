import { z } from 'zod';
import type { DocumentContent } from '@contracts/documents.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { documentsGateway } from '@renderer/platform/documents';
import { connectionGateway } from '@renderer/platform/connection';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z
  .object({
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    scope: z.string(),
  })
  .catchall(z.json());
const explicitLink = z
  .object({
    source_document: z.string(),
    source_revision: revision,
    target_document: z.string(),
    target_revision: revision.nullable(),
    target_status: z.string(),
    direction: z.enum(['incoming', 'outgoing']),
    href: z.string(),
    fragment: z.string(),
    evidence,
    origin: z.string().optional(),
    change: z.string().optional(),
  })
  .catchall(z.json());
const entity = z
  .object({
    document: z.string(),
    source_revision: revision,
    id: z.string(),
    label: z.string(),
    type: z.string(),
  })
  .catchall(z.json());
const candidate = z
  .object({
    status: z.literal('candidate'),
    reason: z.string(),
    source_entity: entity,
    target_entity: entity,
  })
  .catchall(z.json());
const state = z
  .object({
    document: z.string(),
    source_revision: revision.nullable(),
    status: z.string(),
  })
  .catchall(z.json());
const skipped = z
  .object({
    document: z.string(),
    code: z.string(),
    component: z.string().optional(),
  })
  .catchall(z.json());
const connectionsSchema = z
  .object({
    document: z.string(),
    source_revision: revision,
    layer: z.literal('machine'),
    explicit_links: z.array(explicitLink),
    candidates: z.array(candidate),
    ontology_states: z.array(state),
    skipped: z.array(skipped),
    truncated: z.boolean(),
    scanned: z.number().int().nonnegative(),
  })
  .catchall(z.json());
const baselineSchema = z.object({
  source_revision: revision,
  graph_revision: revision.nullable(),
  review_revision: revision.nullable(),
  history_revision: revision,
});
const impactDocument = z
  .object({
    document: z.string(),
    source_status: z.string(),
    ontology_status: z.string(),
    review_status: z.string(),
    state_available: z.boolean(),
    needs_review: z.boolean(),
    policy_pending: z.boolean(),
    reasons: z.array(z.string()),
    recommendation: z.string(),
    content_error_confirmed: z.boolean(),
  })
  .catchall(z.json());
const impactSchema = z
  .object({
    document: z.string(),
    source_revision: revision,
    graph_revision: revision.nullable(),
    review_revision: revision.nullable(),
    history_revision: revision.nullable(),
    state_revision: revision.nullable(),
    root: knowledgeValueSchema,
    baseline_status: z.enum(['not_compared', 'compared']),
    baseline: baselineSchema.nullable(),
    changes: z.record(z.string(), z.boolean().nullable()),
    change_status: z.enum(['current_only', 'changed', 'unknown', 'unchanged']),
    scope: knowledgeValueSchema,
    explicit_links: z.array(explicitLink),
    candidates: z.array(candidate),
    documents: z.array(impactDocument),
    restoration: z
      .object({
        source: z.string(),
        graph: z.string(),
        review: z.string(),
        complete: z.boolean(),
        limits: z.array(z.string()),
      })
      .catchall(z.json()),
    skipped: z.array(skipped),
    truncated: z.boolean(),
    complete: z.boolean(),
    scanned: z.number().int().nonnegative(),
  })
  .catchall(z.json());
export type ConnectionsInput = {
  document: string;
  connectionId: string;
  scope: DocumentContent['access'];
};
export type DocumentConnections = z.infer<typeof connectionsSchema>;
export type ExplicitDocumentLink = z.infer<typeof explicitLink>;
export type SharedConceptCandidate = z.infer<typeof candidate>;
export type ConnectionEntity = z.infer<typeof entity>;
export type DocumentImpact = z.infer<typeof impactSchema>;
export type ImpactBaseline = z.infer<typeof baselineSchema>;
export type ConnectionFailure = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
};
export type ConnectionsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ConnectionFailure };
export type LinkExcerpt =
  | { status: 'matched'; quote: string }
  | { status: 'changed' | 'unavailable'; message: string };

/** 같은 연결·사용자·공간·관점에 속한 응답만 현재 자료로 사용합니다. */
async function matchesScope(input: ConnectionsInput): Promise<boolean> {
  const result = await connectionGateway.getState();
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return false;
  const current = result.data;
  return (
    current.connectionId === input.connectionId &&
    current.userId === input.scope.userId &&
    current.policyRevision === input.scope.policyRevision &&
    current.selection?.tenant === input.scope.tenant &&
    current.selection.profile === input.scope.profileId
  );
}

/** 범위 변경을 연결 없음으로 해석하지 않고 부모의 재확인을 요청합니다. */
function scopeChanged<T>(): ConnectionsResult<T> {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결 또는 작업 공간이 변경되었습니다. 현재 범위를 다시 확인해 주세요.',
    },
  };
}

/** 명시 링크와 이름/유형 후보를 그대로 읽고 서로 같은 관계로 합치지 않습니다. */
export async function loadDocumentConnections(
  input: ConnectionsInput,
): Promise<ConnectionsResult<DocumentConnections>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await workspaceGateway.execute({
      connectionId: input.connectionId,
      operation: 'connections',
      expectedScope: {
        userId: input.scope.userId,
        tenant: input.scope.tenant,
        profileId: input.scope.profileId,
        policyRevision: input.scope.policyRevision,
      },
      input: { document: input.document, limit: 20 },
    });
    if (!result.ok) return result;
    if (!(await matchesScope(input))) return scopeChanged();
    const parsed = connectionsSchema.safeParse(result.data.data);
    if (!parsed.success || parsed.data.document !== input.document)
      throw new Error('invalid_response');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message:
          '문서 연결을 읽지 못했습니다. 현재 범위에서 다시 확인해 주세요.',
      },
    };
  }
}

/** 실제 지식 조회가 반환한 네 판본만 영향 비교 기준으로 고정합니다. */
export async function readImpactBaseline(
  input: ConnectionsInput,
): Promise<ConnectionsResult<ImpactBaseline>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await knowledgeGateway.read({
      connectionId: input.connectionId,
      document: input.document,
    });
    if (!result.ok) return result;
    if (
      !(await matchesScope(input)) ||
      result.data.document !== input.document ||
      result.data.access.tenant !== input.scope.tenant ||
      result.data.access.profileId !== input.scope.profileId ||
      result.data.access.userId !== input.scope.userId ||
      result.data.access.policyRevision !== input.scope.policyRevision
    )
      return scopeChanged();
    return {
      ok: true,
      data: {
        source_revision: result.data.sourceRevision,
        graph_revision: result.data.graphRevision,
        review_revision: result.data.reviewRevision,
        history_revision: result.data.historyRevision,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'baseline_unavailable',
        message:
          '비교 기준 판본을 읽지 못했습니다. 기준 없는 영향 조회에서는 변경을 추정하지 않습니다.',
      },
    };
  }
}

/** 기준이 없으면 baseline을 생략하고 현재 직접 연결의 제한된 영향만 조회합니다. */
export async function loadDocumentImpact(
  input: ConnectionsInput,
  baseline: ImpactBaseline | null,
): Promise<ConnectionsResult<DocumentImpact>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await workspaceGateway.execute({
      connectionId: input.connectionId,
      operation: 'impact',
      expectedScope: {
        userId: input.scope.userId,
        tenant: input.scope.tenant,
        profileId: input.scope.profileId,
        policyRevision: input.scope.policyRevision,
      },
      input: {
        document: input.document,
        limit: 20,
        ...(baseline ? { baseline } : {}),
      },
    });
    if (!result.ok) return result;
    if (!(await matchesScope(input))) return scopeChanged();
    const parsed = impactSchema.safeParse(result.data.data);
    if (!parsed.success || parsed.data.document !== input.document)
      throw new Error('invalid_response');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message:
          '변경 영향 안내를 읽지 못했습니다. 이미 저장한 자료를 다시 저장하거나 재추출하지 마세요.',
      },
    };
  }
}

/** 링크 판본과 동일한 전체 원문에서만 인용하며 최신 판본을 옛 인용으로 대신하지 않습니다. */
export async function readLinkExcerpt(
  input: ConnectionsInput,
  link: ExplicitDocumentLink,
): Promise<ConnectionsResult<LinkExcerpt>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await documentsGateway.content({
      connectionId: input.connectionId,
      document: link.source_document,
    });
    if (!result.ok) return result;
    if (
      !(await matchesScope(input)) ||
      result.data.access.userId !== input.scope.userId ||
      result.data.access.tenant !== input.scope.tenant ||
      result.data.access.profileId !== input.scope.profileId ||
      result.data.access.policyRevision !== input.scope.policyRevision
    )
      return scopeChanged();
    if (result.data.revision !== link.source_revision)
      return {
        ok: true,
        data: {
          status: 'changed',
          message:
            '링크 조회 후 원문 판본이 바뀌어 당시 인용을 현재 본문으로 대신하지 않습니다.',
        },
      };
    const lines = result.data.content.split('\n');
    if (
      link.evidence.end_line < link.evidence.start_line ||
      link.evidence.end_line > lines.length
    )
      return {
        ok: true,
        data: {
          status: 'unavailable',
          message: '서버의 인용 줄 범위를 현재 원문에서 확인하지 못했습니다.',
        },
      };
    return {
      ok: true,
      data: {
        status: 'matched',
        quote: lines
          .slice(link.evidence.start_line - 1, link.evidence.end_line)
          .join('\n'),
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'read_failed',
        message:
          '링크 근거 원문을 읽지 못했습니다. 당시 판본과 위치 정보는 보존합니다.',
      },
    };
  }
}
