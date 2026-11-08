import { knowledgeGateway } from '@renderer/platform/knowledge';
import { notifyReadChange } from '@renderer/shared/lib/readQueries';
import { sameAccessRevision } from '@contracts/connection.contract';
import { z } from 'zod';
import type { DocumentContent } from '@contracts/documents.contract';
import { isDocumentPath } from '@contracts/documents.contract';
import type { ConnectionSnapshot } from '@contracts/connection.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { workspaceGateway } from '@renderer/platform/workspace';
import type { WorkspaceScope } from '@contracts/workspace.contract';

export type ContentFailure = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
  cleanupWarningCount?: number;
};
export type ContentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ContentFailure };
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const savedSchema = z.object({
  document: z.string(),
  revision,
  changed: z.boolean(),
  history_id: z.string().nullable(),
  cleanup_failures: z.array(z.unknown()),
  retry_policy: z.literal('read_and_reconcile'),
  audit_status: z.enum(['recorded', 'pending_reconcile']).optional(),
  audit_error: z.string().nullable().optional(),
  restored_from: z.string().optional(),
});
const versionSchema = z.object({
  history_id: z.string(),
  revision,
  size_bytes: z.number().int().nonnegative(),
  archived_at: z.string().nullable(),
  author: z
    .union([
      z.string(),
      z
        .object({ user_id: z.string(), display_name: z.string().optional() })
        .catchall(z.json()),
    ])
    .nullable(),
  origin: z.object({ kind: z.string() }).catchall(z.json()).optional(),
  reason: z.string().nullable(),
});
const historySchema = z.object({
  document: z.string(),
  current: z.object({ revision }),
  items: z.array(versionSchema),
  catalog_revision: revision,
  next_cursor: z.string().nullable(),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.object({ history_id: z.string(), code: z.string() })),
  requires_refresh: z.boolean(),
});
const historicalSchema = versionSchema.extend({
  document: z.string(),
  content: z.string(),
});
export type SaveReceipt = z.infer<typeof savedSchema>;
export type HistoryPage = z.infer<typeof historySchema>;
export type HistoricalContent = z.infer<typeof historicalSchema>;
export type ContentSession = {
  principal?: { userId: string; displayName: string };
  current: DocumentContent;
  canWrite: boolean;
  canExtract: boolean;
};

/** 공개 쓰기 계약에는 권한 기준 네 필드만 전달합니다. */
function contentScope(current: DocumentContent): WorkspaceScope {
  const { userId, tenant, profileId, accessRevision, policyRevision } =
    current.access;
  return { userId, tenant, profileId, accessRevision, policyRevision };
}

/** 응답과 현재 인증 선택이 같아야 본문과 후속 작업을 공개합니다. */
function matches(
  snapshot: ConnectionSnapshot,
  current: DocumentContent,
): boolean {
  return (
    snapshot.status === 'connected' &&
    snapshot.connectionId === current.connectionId &&
    snapshot.userId === current.access.userId &&
    sameAccessRevision(snapshot, current.access) &&
    snapshot.selection?.tenant === current.access.tenant &&
    snapshot.selection.profile === current.access.profileId
  );
}
/** 다른 인증 범위의 응답은 실패로 돌려 초안과 화면을 분리합니다. */
function changedScope<T>(): ContentResult<T> {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결 또는 권한 범위가 바뀌었습니다. 현재 범위를 다시 확인해 주세요.',
    },
  };
}
/** 기존 main의 현재 인증 상태를 확인하며 renderer에서 인증 정보를 처리하지 않습니다. */
export async function verifyContentScope(
  current: DocumentContent,
): Promise<boolean> {
  try {
    const result = await connectionGateway.getState();
    return result.ok && matches(result.data, current);
  } catch {
    return false;
  }
}
/** 경로와 전체 본문·revision을 함께 읽고 조회 전후 범위를 대조합니다. */
export async function readDocumentContent(
  path: string,
  expected?: DocumentContent,
): Promise<ContentResult<ContentSession>> {
  try {
    if (!isDocumentPath(path))
      return {
        ok: false,
        error: {
          code: 'invalid_path',
          message: '문서 목록에서 읽을 문서를 선택해 주세요.',
        },
      };
    const before = await connectionGateway.getState();
    if (!before.ok) return before;
    if (before.data.status !== 'connected' || !before.data.selection)
      return {
        ok: false,
        error: {
          code: 'not_connected',
          message: '서버와 작업 공간을 먼저 연결해 주세요.',
        },
      };
    if (expected && !matches(before.data, expected)) return changedScope();
    const result = await documentsGateway.content({
      connectionId: before.data.connectionId,
      document: path,
    });
    if (!result.ok) return result;
    const after = await connectionGateway.getState();
    if (
      !after.ok ||
      !matches(before.data, result.data) ||
      !matches(after.data, result.data) ||
      result.data.document !== path
    )
      return changedScope();
    const membership = before.data.workspaces.find(
      (item: (typeof before.data.workspaces)[number]): boolean =>
        item.id === result.data.access.tenant,
    );
    return {
      ok: true,
      data: {
        current: result.data,
        ...(before.data.displayName
          ? {
              principal: {
                userId: before.data.userId,
                displayName: before.data.displayName,
              },
            }
          : {}),
        canWrite: membership?.permissions.includes('write') ?? false,
        canExtract: membership?.permissions.includes('ontology_write') ?? false,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'read_failed',
        message:
          '본문을 불러오지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.',
      },
    };
  }
}
/** 저장 요청은 실제 읽은 revision으로 한 번만 보내고 응답 유실을 보수적으로 표시합니다. */
export async function saveDocumentContent(
  base: DocumentContent,
  content: string,
): Promise<ContentResult<SaveReceipt>> {
  try {
    if (!(await verifyContentScope(base))) return changedScope();
    const result = await workspaceGateway.execute({
      connectionId: base.connectionId,
      expectedScope: contentScope(base),
      operation: 'saveDocument',
      input: {
        document: base.document,
        content,
        expected_revision: base.revision,
      },
    });
    if (!result.ok) return result;
    if (!(await verifyContentScope(base)))
      throw new Error('scope_changed_after_write');
    const parsed = savedSchema.safeParse(result.data.data);
    if (!parsed.success || parsed.data.document !== base.document)
      throw new Error('invalid_receipt');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '저장 완료 여부를 확인하지 못했습니다. 자동 재저장하지 않고 최신 본문과 초안을 비교해 주세요.',
      },
    };
  } finally {
    notifyReadChange();
  }
}
/** 선택한 보관 판본을 현재 전체 파일 기준으로 복원하며 응답 유실 시 재전송하지 않습니다. */
export async function restoreDocumentVersion(
  current: DocumentContent,
  historical: HistoricalContent,
): Promise<ContentResult<SaveReceipt>> {
  try {
    if (historical.document !== current.document)
      return {
        ok: false,
        error: {
          code: 'invalid_version',
          message: '같은 문서에서 비교한 과거 버전을 선택해 주세요.',
        },
      };
    if (!(await verifyContentScope(current))) return changedScope();
    const result = await workspaceGateway.execute({
      connectionId: current.connectionId,
      expectedScope: contentScope(current),
      operation: 'restoreDocument',
      input: {
        document: current.document,
        history_id: historical.history_id,
        expected_revision: current.revision,
      },
    });
    if (!result.ok) return result;
    if (!(await verifyContentScope(current)))
      throw new Error('scope_changed_after_restore');
    const parsed = savedSchema.safeParse(result.data.data);
    if (
      !parsed.success ||
      parsed.data.document !== current.document ||
      parsed.data.restored_from !== historical.history_id
    )
      throw new Error('invalid_restore_receipt');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '복원 완료 여부를 확인하지 못했습니다. 자동으로 다시 복원하지 않고 현재 본문과 이력을 확인해 주세요.',
      },
    };
  } finally {
    notifyReadChange();
  }
}
/** 서버 cursor를 그대로 전달하고 불완전·변경된 이력 목록을 보존합니다. */
export async function readDocumentHistory(
  current: DocumentContent,
  cursor: string | null,
): Promise<ContentResult<HistoryPage>> {
  try {
    if (!(await verifyContentScope(current))) return changedScope();
    const result = await workspaceGateway.execute({
      connectionId: current.connectionId,
      expectedScope: contentScope(current),
      operation: 'documentVersions',
      input: { document: current.document, limit: 20, cursor },
    });
    if (!result.ok) return result;
    if (!(await verifyContentScope(current))) return changedScope();
    const parsed = historySchema.safeParse(result.data.data);
    if (!parsed.success || parsed.data.document !== current.document)
      throw new Error('invalid_history');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'history_failed',
        message: '전체 이력 목록을 확인하지 못했습니다. 다시 조회해 주세요.',
      },
    };
  }
}
/** 과거 전체 본문은 읽기만 하며 현재 문서나 원본을 변경하지 않습니다. */
export async function readHistoricalContent(
  current: DocumentContent,
  historyId: string,
): Promise<ContentResult<HistoricalContent>> {
  try {
    if (!(await verifyContentScope(current))) return changedScope();
    const result = await workspaceGateway.execute({
      connectionId: current.connectionId,
      expectedScope: contentScope(current),
      operation: 'documentVersion',
      input: { document: current.document, history_id: historyId },
    });
    if (!result.ok) return result;
    if (!(await verifyContentScope(current))) return changedScope();
    const parsed = historicalSchema.safeParse(result.data.data);
    if (
      !parsed.success ||
      parsed.data.document !== current.document ||
      parsed.data.history_id !== historyId
    )
      throw new Error('invalid_version');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'version_failed',
        message: '선택한 과거 전체 본문을 읽지 못했습니다.',
      },
    };
  }
}

export type DocumentRelationStatus = 'ready' | 'stale' | 'missing' | 'unknown';
/** 현재 본문의 관계 상태를 서버 판정으로 읽으며 오류를 미추출로 바꾸지 않습니다. */
export async function readDocumentRelationStatus(
  current: DocumentContent,
): Promise<DocumentRelationStatus> {
  try {
    if (!(await verifyContentScope(current))) return 'unknown';
    const result = await knowledgeGateway.read({
      connectionId: current.connectionId,
      document: current.document,
    });
    if (
      !result.ok ||
      result.data.sourceRevision !== current.revision ||
      !(await verifyContentScope(current))
    )
      return 'unknown';
    if (
      result.data.machineGraph.status === 'stale' ||
      result.data.machineGraph.needs_reextraction === true
    )
      return 'stale';
    return result.data.machineGraph.status === 'ready'
      ? 'ready'
      : result.data.machineGraph.status === 'missing'
        ? 'missing'
        : 'unknown';
  } catch {
    return 'unknown';
  }
}
