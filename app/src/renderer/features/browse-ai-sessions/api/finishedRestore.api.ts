import type { AnalysisJob } from '@contracts/analysis.contract';
import { analysisGateway } from '@renderer/platform/analysis';
import { finishedScopeKey, restoreFinished } from '../model/finishedActivities';
import { assertSessionScope, readSessionScope } from './aiSessions.api';

/** 복원을 위해 읽는 작업 페이지의 상한입니다(페이지당 20건). */
const maxPages = 20;
/** 연결 ID는 연결마다 바뀌므로 같은 연결에서만 사용자·공간 키를 재사용합니다. */
const keyByConnection = new Map<string, string>();

/** 현재 연결의 사용자·공간 단위 확인 기록 키를 알려 줍니다. 연결이 없으면 던집니다. */
export async function readFinishedScope(): Promise<{
  connectionId: string;
  key: string;
}> {
  const scope = await readSessionScope();
  const cached = keyByConnection.get(scope.connectionId);
  if (cached) return { connectionId: scope.connectionId, key: cached };
  const key = finishedScopeKey(
    scope.expectedScope.userId,
    scope.expectedScope.tenant,
  );
  keyByConnection.set(scope.connectionId, key);
  return { connectionId: scope.connectionId, key };
}

/**
 * 서버의 내 분석 작업 기록을 읽어, 앱이 꺼진 사이 끝난 작업을 확인 목록에 복원합니다.
 * 읽기만 하며 새 실행을 만들지 않습니다.
 */
export async function restoreFinishedFromServer(): Promise<void> {
  const scope = await readSessionScope();
  const { key } = await readFinishedScope();
  const startedAt = new Date().toISOString();
  const jobs: AnalysisJob[] = [];
  let complete = true;
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await analysisGateway.list({
      connectionId: scope.connectionId,
      sourceId: null,
      cursor,
    });
    if (!result.ok) {
      complete = false;
      break;
    }
    const value = result.data;
    if (value.truncated || value.skippedCount > 0 || value.requiresRefresh)
      complete = false;
    jobs.push(...value.items);
    cursor = value.nextCursor;
    if (cursor === null) break;
    if (page === maxPages - 1) complete = false;
  }
  // 조회 중 다른 계정·공간으로 바뀐 응답은 기록하지 않습니다.
  await assertSessionScope(scope);
  restoreFinished(key, jobs, startedAt, complete);
}
