import type {
  KnowledgeComparisonListRequest,
  KnowledgeComparisonReadRequest,
  KnowledgeComparisonRestartRequest,
  KnowledgeComparisonPageResult,
  KnowledgeComparisonDetailResult,
} from '@contracts/knowledgeComparisons.contract';
import { knowledgeComparisonsGateway } from '@renderer/platform/knowledgeComparisons';
import { assertSessionScope, throwIfScopeError } from './aiSessions.api';

type ComparisonPage = Extract<
  KnowledgeComparisonPageResult,
  { ok: true }
>['data'];
type ComparisonDetail = Extract<
  KnowledgeComparisonDetailResult,
  { ok: true }
>['data'];

/** 실제 개인 목록만 읽고 현재 접근 범위를 재확인합니다. */
export async function listComparisons(
  request: KnowledgeComparisonListRequest,
): Promise<ComparisonPage> {
  const result = await knowledgeComparisonsGateway.list(request);
  await assertSessionScope(request);
  if (!result.ok) {
    throwIfScopeError(result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}
/** 작업 선택은 조회만 수행하며 재실행은 명시 행동으로만 분리합니다. */
export async function readComparison(
  request: KnowledgeComparisonReadRequest,
): Promise<ComparisonDetail> {
  const result = await knowledgeComparisonsGateway.read(request);
  await assertSessionScope(request);
  if (!result.ok) {
    throwIfScopeError(result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}
/** 고정 비교 판본에서 사용자가 요청한 새 대조만 시작합니다. */
export async function restartComparison(
  request: KnowledgeComparisonRestartRequest,
): Promise<ComparisonDetail> {
  const result = await knowledgeComparisonsGateway.restart(request);
  await assertSessionScope(request);
  if (!result.ok) {
    throwIfScopeError(result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}
/** 실행 중단 뒤에도 이전·부분 결과를 읽을 수 있게 합니다. */
export async function stopComparison(
  request: KnowledgeComparisonReadRequest,
): Promise<ComparisonDetail> {
  const result = await knowledgeComparisonsGateway.stopLocal(request);
  await assertSessionScope(request);
  if (!result.ok) {
    throwIfScopeError(result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}
