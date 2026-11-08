import type {
  AiActivity,
  AiSessionsSnapshot,
} from '@contracts/aiSessions.contract';
import { aiSessionsGateway } from '@renderer/platform/aiSessions';
import { analysisGateway } from '@renderer/platform/analysis';
import { questionRunsGateway } from '@renderer/platform/questionRuns';
import { proposalExecutionGateway } from '@renderer/platform/proposalExecution';
import { knowledgeComparisonsGateway } from '@renderer/platform/knowledgeComparisons';
import { analysisProposalsGateway } from '@renderer/platform/analysisProposals';
import { isDocumentPath } from '@contracts/documents.contract';
import { z } from 'zod';
import {
  assertSessionScope,
  readSessionScope,
  SessionScopeError,
  throwIfScopeError,
} from './aiSessions.api';

/** 전역 상태에도 현재 연결 범위를 고정하고 늦은 다른 계정 응답은 버립니다. */
export async function readSessionActivity(
  connectionId: string | undefined,
  refreshUsage: boolean,
): Promise<AiSessionsSnapshot> {
  const scope = await readSessionScope();
  if (connectionId !== undefined && connectionId !== scope.connectionId)
    throw new SessionScopeError('현재 연결의 세션 상태를 다시 확인해 주세요.');
  const result = await aiSessionsGateway.read({
    connectionId: scope.connectionId,
    refreshUsage,
  });
  await assertSessionScope(scope);
  if (!result.ok) {
    throwIfScopeError(result.error);
    throw new Error(result.error.message);
  }
  const activities = await Promise.all(
    result.data.activities.map(
      async (activity: AiActivity): Promise<AiActivity> => {
        if (
          activity.kind !== 'proposal' ||
          activity.document ||
          !activity.proposalId
        )
          return activity;
        try {
          const proposal = await analysisProposalsGateway.execute({
            ...scope,
            operation: 'read',
            input: { proposal_id: activity.proposalId },
          });
          if (!proposal.ok) {
            throwIfScopeError(proposal.error);
            return activity;
          }
          const target = z
            .object({
              proposal_id: z.literal(activity.proposalId),
              basis: z.object({
                target_document: z.string().refine(isDocumentPath),
              }),
            })
            .safeParse(proposal.data);
          return target.success
            ? { ...activity, document: target.data.basis.target_document }
            : activity;
        } catch (cause: unknown) {
          throwIfScopeError(cause);
          return activity;
        }
      },
    ),
  );
  await assertSessionScope(scope);
  return { ...result.data, activities };
}

/** 목록의 선택한 실행만 현재 판본으로 중단하고 다른 세션은 그대로 유지합니다. */
export async function stopSessionActivity(activity: AiActivity): Promise<void> {
  const scope = await readSessionScope();
  if (activity.connectionId !== scope.connectionId)
    throw new SessionScopeError(
      '연결이 변경되었습니다. 현재 세션을 다시 확인해 주세요.',
    );
  if (activity.kind === 'analysis') {
    const result = await analysisGateway.stopLocal({
      connectionId: scope.connectionId,
      jobId: activity.id,
    });
    if (!result.ok) {
      throwIfScopeError(result.error);
      throw new Error(result.error.message);
    }
  } else if (activity.kind === 'question') {
    const current = await questionRunsGateway.read({
      ...scope,
      questionRunId: activity.id,
    });
    if (!current.ok) {
      throwIfScopeError(current.error);
      throw new Error(current.error.message);
    }
    await assertSessionScope(scope);
    const result = await questionRunsGateway.cancel({
      ...scope,
      questionRunId: activity.id,
      expectedStateRevision: current.data.stateRevision,
      requestId: crypto.randomUUID().replaceAll('-', ''),
    });
    if (!result.ok) {
      throwIfScopeError(result.error);
      throw new Error(result.error.message);
    }
  } else if (activity.kind === 'comparison') {
    const result = await knowledgeComparisonsGateway.stopLocal({
      ...scope,
      comparisonId: activity.id,
    });
    if (!result.ok) {
      throwIfScopeError(result.error);
      throw new Error(result.error.message);
    }
  } else {
    if (!activity.proposalId)
      throw new Error('재추출 작업의 대상을 확인할 수 없습니다.');
    const result = await proposalExecutionGateway.cancel({
      ...scope,
      proposalId: activity.proposalId,
      executionId: activity.id,
    });
    if (!result.ok) {
      throwIfScopeError(result.error);
      throw new Error(result.error.message);
    }
  }
  await assertSessionScope(scope);
}
