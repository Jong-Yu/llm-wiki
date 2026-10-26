import { z } from 'zod';
import type { DocumentContent } from '@contracts/documents.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import { documentsGateway } from '@renderer/platform/documents';
import { connectionGateway } from '@renderer/platform/connection';

const savedSchema = z.object({
  document: z.string(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  changed: z.boolean(),
  history_id: z.string().nullable(),
  cleanup_failures: z.array(z.unknown()),
  mutation_receipt: z.null(),
  retry_policy: z.literal('read_and_reconcile'),
});
export type DocumentSaveOutcome = {
  document: string;
  revision: string;
  changed: boolean;
  historyId: string | null;
  cleanupWarningCount: number;
};
export type EditorFailure = {
  code: string;
  message: string;
  status?: number;
  traceId?: string;
};
export type EditorSaveResult =
  | { ok: true; outcome: DocumentSaveOutcome }
  | { ok: false; error: EditorFailure };
export type EditorReadResult =
  | { ok: true; current: DocumentContent }
  | { ok: false; error: EditorFailure };

/** 현재 문서와 같은 연결·주체·조회 범위인지 전송 전후에 대조합니다. */
async function currentScope(current: DocumentContent): Promise<boolean> {
  const result = await connectionGateway.getState();
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return false;
  const state = result.data;
  return (
    state.connectionId === current.connectionId &&
    state.userId === current.access.userId &&
    state.policyRevision === current.access.policyRevision &&
    state.selection?.tenant === current.access.tenant &&
    state.selection.profile === current.access.profileId
  );
}

/** 범위 변경은 저장 실패와 구분하고 원래 초안을 보존하게 합니다. */
function changedScope(): { ok: false; error: EditorFailure } {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결 또는 작업 공간이 변경되었습니다. 현재 범위를 다시 확인해 주세요.',
    },
  };
}

/** 원래 읽은 판본으로 한 번만 저장하며 미확정 응답을 자동 재전송하지 않습니다. */
export async function saveWikiDocument(
  current: DocumentContent,
  content: string,
): Promise<EditorSaveResult> {
  try {
    if (!(await currentScope(current))) return changedScope();
    const result = await workspaceGateway.execute({
      connectionId: current.connectionId,
      operation: 'saveDocument',
      expectedScope: {
        userId: current.access.userId,
        tenant: current.access.tenant,
        profileId: current.access.profileId,
        policyRevision: current.access.policyRevision,
      },
      input: {
        document: current.document,
        content,
        expected_revision: current.revision,
      },
    });
    if (!result.ok) return result;
    if (!(await currentScope(current)))
      return {
        ok: false,
        error: {
          code: 'outcome_unknown',
          message:
            '저장 중 연결 범위가 변경되었습니다. 저장 결과를 현재 본문과 대조해 주세요.',
        },
      };
    const parsed = savedSchema.safeParse(result.data.data);
    if (!parsed.success || parsed.data.document !== current.document)
      return {
        ok: false,
        error: {
          code: 'outcome_unknown',
          message:
            '저장 응답을 확인하지 못했습니다. 현재 본문을 확인하고 자동 재저장은 하지 마세요.',
        },
      };
    return {
      ok: true,
      outcome: {
        document: parsed.data.document,
        revision: parsed.data.revision,
        changed: parsed.data.changed,
        historyId: parsed.data.history_id,
        cleanupWarningCount: parsed.data.cleanup_failures.length,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '저장 완료 여부를 확인하지 못했습니다. 초안을 보존하고 현재 본문을 확인해 주세요.',
      },
    };
  }
}

/** 최신 전체 본문을 읽지만 이 결과만으로 이전 저장 요청의 성공을 확정하지 않습니다. */
export async function readCurrentWiki(
  current: DocumentContent,
): Promise<EditorReadResult> {
  try {
    if (!(await currentScope(current))) return changedScope();
    const result = await documentsGateway.content({
      connectionId: current.connectionId,
      document: current.document,
    });
    if (!result.ok) return result;
    if (
      !(await currentScope(current)) ||
      result.data.access.tenant !== current.access.tenant ||
      result.data.access.profileId !== current.access.profileId ||
      result.data.access.policyRevision !== current.access.policyRevision ||
      result.data.access.userId !== current.access.userId
    )
      return changedScope();
    return { ok: true, current: result.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'read_failed',
        message:
          '현재 본문을 읽지 못했습니다. 초안을 보존한 채 다시 확인해 주세요.',
      },
    };
  }
}
