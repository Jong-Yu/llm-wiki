import { connectionGateway } from '@renderer/platform/connection';
import type {
  QuestionSession,
  QuestionOutcome,
} from '@contracts/questionRuns.contract';
import { questionRunsGateway } from '@renderer/platform/questionRuns';
import type {
  QuestionRunsBridge,
  QuestionDetailResult,
  QuestionPageResult,
} from '@contracts/questionRuns.contract';

/** IPC 예외도 결과 미확인으로 보존하고 쓰기를 자동 재전송하지 않습니다. */
export async function requestQuestion<
  T extends QuestionDetailResult | QuestionPageResult,
>(
  operation: () => Promise<T>,
): Promise<T | { ok: false; error: { code: string; message: string } }> {
  try {
    return await operation();
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '앱 응답을 확인하지 못했습니다. 새 실행 전에 기존 요청을 조회해 주세요.',
      },
    };
  }
}
export const questionRunsApi: QuestionRunsBridge = questionRunsGateway;

/** 현재 선택된 범위를 고정하며 토큰과 서버 원본을 요청 결과에 넣지 않습니다. */
export async function loadQuestionScope(
  tenant: string | undefined,
): Promise<QuestionOutcome<{ session: QuestionSession; canWrite: boolean }>> {
  try {
    const result = await connectionGateway.getState();
    if (
      !result.ok ||
      result.data.status !== 'connected' ||
      !result.data.selection ||
      result.data.selection.tenant !== tenant
    )
      return {
        ok: false,
        error: {
          code: 'connection_required',
          message: '현재 서버와 작업 공간을 먼저 선택해 주세요.',
        },
      };
    const current = result.data;
    const selection = current.selection;
    if (!selection)
      return {
        ok: false,
        error: {
          code: 'connection_required',
          message: '작업 공간을 선택해 주세요.',
        },
      };
    return {
      ok: true,
      data: {
        session: {
          connectionId: current.connectionId,
          expectedScope: {
            userId: current.userId,
            tenant: selection.tenant,
            profileId: selection.profile,
            policyRevision: current.policyRevision,
          },
        },
        canWrite:
          current.workspaces
            .find(
              (workspace: (typeof current.workspaces)[number]): boolean =>
                workspace.id === selection.tenant,
            )
            ?.permissions.includes('conversation_write') ?? false,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '현재 앱 연결을 확인할 수 없습니다.',
      },
    };
  }
}
