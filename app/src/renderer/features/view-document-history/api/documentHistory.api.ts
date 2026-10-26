import { z } from 'zod';
import type { DocumentContent } from '@contracts/documents.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import { documentsGateway } from '@renderer/platform/documents';
import { connectionGateway } from '@renderer/platform/connection';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const versionSchema = z.object({
  history_id: z.string(),
  revision,
  size_bytes: z.number().int().nonnegative(),
  archived_at: z.string().nullable(),
  author: z.string().nullable(),
  reason: z.string().nullable(),
});
const pageSchema = z.object({
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
const restoreSchema = z.object({
  document: z.string(),
  revision,
  changed: z.boolean(),
  history_id: z.string().nullable(),
  restored_from: z.string(),
  cleanup_failures: z.array(z.unknown()),
  mutation_receipt: z.null(),
  retry_policy: z.literal('read_and_reconcile'),
});
export type DocumentHistoryScope = DocumentContent['access'];
export type DocumentHistoryInput = {
  document: string;
  connectionId: string;
  scope: DocumentHistoryScope;
};
export type DocumentHistoryVersion = z.infer<typeof versionSchema>;
export type DocumentHistoryPage = z.infer<typeof pageSchema>;
export type HistoricalDocument = z.infer<typeof historicalSchema>;
export type DocumentRestoreOutcome = {
  document: string;
  revision: string;
  changed: boolean;
  historyId: string | null;
  restoredFrom: string;
  cleanupWarningCount: number;
};
export type HistoryFailure = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
};
export type HistoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: HistoryFailure };

/** 현재 main 선택을 문서 이력의 원래 조회 범위와 대조합니다. */
async function matchesScope(input: DocumentHistoryInput): Promise<boolean> {
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

/** 문서 소속/권한이 바뀌면 과거 자료를 현재 범위로 노출하지 않습니다. */
function scopeChanged<T>(): HistoryResult<T> {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결 또는 작업 공간이 변경되었습니다. 현재 범위를 다시 확인해 주세요.',
    },
  };
}

/** 현재 문서의 페이지 이력을 서버 cursor 그대로 읽습니다. */
export async function loadDocumentVersions(
  input: DocumentHistoryInput,
  cursor: string | null,
): Promise<HistoryResult<DocumentHistoryPage>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await workspaceGateway.execute({
      connectionId: input.connectionId,
      operation: 'documentVersions',
      expectedScope: {
        userId: input.scope.userId,
        tenant: input.scope.tenant,
        profileId: input.scope.profileId,
        policyRevision: input.scope.policyRevision,
      },
      input: { document: input.document, limit: 20, cursor },
    });
    if (!result.ok) return result;
    if (!(await matchesScope(input))) return scopeChanged();
    const parsed = pageSchema.safeParse(result.data.data);
    if (!parsed.success || parsed.data.document !== input.document)
      throw new Error('invalid_response');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message:
          '문서 이력 목록을 읽지 못했습니다. 같은 범위에서 다시 확인해 주세요.',
      },
    };
  }
}

/** 과거 전체 파일 하나를 읽으며 현재 본문을 바꾸지 않습니다. */
export async function loadDocumentVersion(
  input: DocumentHistoryInput,
  historyId: string,
): Promise<HistoryResult<HistoricalDocument>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await workspaceGateway.execute({
      connectionId: input.connectionId,
      operation: 'documentVersion',
      expectedScope: {
        userId: input.scope.userId,
        tenant: input.scope.tenant,
        profileId: input.scope.profileId,
        policyRevision: input.scope.policyRevision,
      },
      input: { document: input.document, history_id: historyId },
    });
    if (!result.ok) return result;
    if (!(await matchesScope(input))) return scopeChanged();
    const parsed = historicalSchema.safeParse(result.data.data);
    if (
      !parsed.success ||
      parsed.data.document !== input.document ||
      parsed.data.history_id !== historyId
    )
      throw new Error('invalid_response');
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message:
          '과거 전체 본문을 읽지 못했습니다. 현재 본문은 변경하지 않았습니다.',
      },
    };
  }
}

/** 복원 비교에 사용할 실제 현재 본문/revision을 함께 읽습니다. */
export async function loadCurrentDocument(
  input: DocumentHistoryInput,
): Promise<HistoryResult<DocumentContent>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await documentsGateway.content({
      connectionId: input.connectionId,
      document: input.document,
    });
    if (!result.ok) return result;
    if (
      !(await matchesScope(input)) ||
      result.data.access.tenant !== input.scope.tenant ||
      result.data.access.userId !== input.scope.userId ||
      result.data.access.profileId !== input.scope.profileId ||
      result.data.access.policyRevision !== input.scope.policyRevision
    )
      return scopeChanged();
    return { ok: true, data: result.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'read_failed',
        message: '비교할 현재 본문을 읽지 못했습니다.',
      },
    };
  }
}

/** 대조한 현재 revision에서 과거 본문을 새 저장으로 복원하며 자동 재시도하지 않습니다. */
export async function restoreDocumentVersion(
  input: DocumentHistoryInput,
  old: HistoricalDocument,
  current: DocumentContent,
): Promise<HistoryResult<DocumentRestoreOutcome>> {
  try {
    if (!(await matchesScope(input))) return scopeChanged();
    const result = await workspaceGateway.execute({
      connectionId: input.connectionId,
      operation: 'restoreDocument',
      expectedScope: {
        userId: input.scope.userId,
        tenant: input.scope.tenant,
        profileId: input.scope.profileId,
        policyRevision: input.scope.policyRevision,
      },
      input: {
        document: input.document,
        history_id: old.history_id,
        expected_revision: current.revision,
      },
    });
    if (!result.ok) return result;
    if (!(await matchesScope(input)))
      return {
        ok: false,
        error: {
          code: 'outcome_unknown',
          message:
            '복원 중 조회 범위가 변경되어 완료 여부를 확인하지 못했습니다.',
        },
      };
    const parsed = restoreSchema.safeParse(result.data.data);
    if (
      !parsed.success ||
      parsed.data.document !== input.document ||
      parsed.data.restored_from !== old.history_id
    )
      throw new Error('invalid_response');
    return {
      ok: true,
      data: {
        document: parsed.data.document,
        revision: parsed.data.revision,
        changed: parsed.data.changed,
        historyId: parsed.data.history_id,
        restoredFrom: parsed.data.restored_from,
        cleanupWarningCount: parsed.data.cleanup_failures.length,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '복원 요청의 완료 여부를 확인하지 못했습니다. 자동 복원 재시도 없이 현재 본문을 다시 확인해 주세요.',
      },
    };
  }
}
