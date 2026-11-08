import { z } from 'zod';
import type { AiActivity } from '@contracts/aiSessions.contract';
import type { AnalysisJob } from '@contracts/analysis.contract';

/**
 * 끝난 뒤 아직 확인하지 않은 작업 한 건입니다.
 * 이 기기에서 관찰한 것과, 서버 작업 기록(분석 job의 마지막 이벤트 시각)으로 복원한 것을 함께 담습니다.
 */
export const finishedActivitySchema = z.object({
  kind: z.enum(['analysis', 'question', 'proposal', 'comparison']),
  id: z.string(),
  endedAt: z.string(),
  document: z.string().optional(),
  conversationId: z.string().optional(),
  proposalId: z.string().optional(),
  /** 복원한 작업의 표시용 제목·결과입니다(목록 한 페이지에 없어도 행을 그리기 위함). */
  title: z.string().optional(),
  result: z.string().optional(),
});
export type FinishedActivity = z.infer<typeof finishedActivitySchema>;

/**
 * 확인 상태의 저장 단위입니다. 연결 ID는 연결할 때마다 바뀌므로 쓰지 않고
 * 사용자·작업 공간 단위로 이 기기의 localStorage에 둡니다(다른 사용자와 섞이지 않고, 앱을 껐다 켜도 남습니다).
 */
const storeSchema = z.object({
  /** 마지막으로 AI 세션을 열어 복원 조회를 마친 시각(조회 시작 기준)입니다. */
  seenAt: z.string().nullable(),
  /** ✕로 확인한 작업 키입니다. 서버 기록에서 다시 복원되지 않게 합니다. */
  dismissed: z.array(z.string()),
  items: z.array(finishedActivitySchema),
});
type FinishedStore = z.infer<typeof storeSchema>;

/**
 * 이전 방식의 기록(`wiki.ai-sessions.finished:<연결 ID>`)은 지우지 않고 읽지도 않습니다.
 * 연결 ID가 앱을 다시 켜면 바뀌어 새 연결에서는 어차피 해당 키를 다시 만나지 못합니다.
 */
const keyPrefix = 'wiki.ai-sessions.finished.v2:';
const changeEvent = 'wiki-ai-finished-changed';
const maxEntries = 50;
const maxDismissed = 500;

/** 같은 사용자·작업 공간의 기록을 가리키는 저장 키입니다. */
export function finishedScopeKey(userId: string, tenant: string): string {
  return JSON.stringify([userId, tenant]);
}

/** 같은 종류·식별자를 한 건으로 다루는 키입니다. */
export function activityKey(item: { kind: string; id: string }): string {
  return `${item.kind}:${item.id}`;
}

const emptyStore: FinishedStore = { seenAt: null, dismissed: [], items: [] };

/** 저장소가 막혀 있어도 화면은 빈 기록으로 동작합니다. */
function readStore(scopeKey: string): FinishedStore {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(keyPrefix + scopeKey) ?? 'null',
    );
    const parsed = storeSchema.safeParse(raw);
    return parsed.success ? parsed.data : emptyStore;
  } catch {
    return emptyStore;
  }
}

function writeStore(scopeKey: string, store: FinishedStore): void {
  const next: FinishedStore = {
    seenAt: store.seenAt,
    dismissed: store.dismissed.slice(-maxDismissed),
    items: [...store.items]
      .sort((left: FinishedActivity, right: FinishedActivity): number =>
        right.endedAt.localeCompare(left.endedAt),
      )
      .slice(0, maxEntries),
  };
  try {
    window.localStorage.setItem(keyPrefix + scopeKey, JSON.stringify(next));
  } catch {
    // 저장하지 못하면 이번 실행 동안만 보이지 않습니다.
  }
  window.dispatchEvent(new Event(changeEvent));
}

/** 확인 전 끝난 작업 목록입니다. */
export function readFinished(scopeKey: string): FinishedActivity[] {
  return readStore(scopeKey).items;
}

/** 이전 관찰에는 있었으나 지금은 없는 활동을 "끝난 작업"으로 기록합니다. */
export function recordFinished(
  scopeKey: string,
  previous: AiActivity[],
  current: AiActivity[],
): void {
  const alive = new Set(current.map(activityKey));
  const ended = previous.filter(
    (item: AiActivity): boolean => !alive.has(activityKey(item)),
  );
  const store = readStore(scopeKey);
  // 다시 돌고 있는 작업은 새로 끝날 때 다시 알려야 하므로 확인 기록에서 뺍니다.
  const dismissed = store.dismissed.filter(
    (key: string): boolean => !alive.has(key),
  );
  const known = new Set(store.items.map(activityKey));
  const endedAt = new Date().toISOString();
  const added: FinishedActivity[] = ended
    .filter((item: AiActivity): boolean => !known.has(activityKey(item)))
    .map((item: AiActivity): FinishedActivity => ({
      kind: item.kind,
      id: item.id,
      endedAt,
      ...(item.document ? { document: item.document } : {}),
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      ...(item.proposalId ? { proposalId: item.proposalId } : {}),
    }));
  if (added.length === 0 && dismissed.length === store.dismissed.length) return;
  writeStore(scopeKey, {
    seenAt: store.seenAt,
    dismissed,
    items: [...added, ...store.items],
  });
}

/** 열어 보거나 ✕로 확인한 작업을 목록에서 빼고 서버 기록에서 다시 복원되지 않게 기억합니다. */
export function dismissFinished(
  scopeKey: string,
  item: { kind: string; id: string },
): void {
  const key = activityKey(item);
  const store = readStore(scopeKey);
  writeStore(scopeKey, {
    seenAt: store.seenAt,
    dismissed: store.dismissed.includes(key)
      ? store.dismissed
      : [...store.dismissed, key],
    items: store.items.filter(
      (entry: FinishedActivity): boolean => activityKey(entry) !== key,
    ),
  });
}

/** 같은 창의 다른 화면이 바꾼 기록도 받도록 구독합니다. */
export function subscribeFinished(listener: () => void): () => void {
  window.addEventListener(changeEvent, listener);
  window.addEventListener('storage', listener);
  return (): void => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener('storage', listener);
  };
}

/** 작업 이벤트 목록에서 가장 늦은 서버 시각을 찾습니다. 형식이 맞지 않으면 건너뜁니다. */
function lastEventTime(events: readonly unknown[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (!event || typeof event !== 'object' || !('timestamp' in event))
      continue;
    const value = event.timestamp;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) continue;
    if (latest === null || Date.parse(value) > Date.parse(latest))
      latest = value;
  }
  return latest;
}

/**
 * 서버 기록상 끝난 분석 작업의 결과 문구입니다. 돌고 있거나 시작 전이면 null입니다.
 * 저장 완료만 "완료"로 보고 실패·중단·결과 거부·저장 확인 필요는 구분해 알립니다.
 */
export function finishedAnalysisResult(job: AnalysisJob): string | null {
  const result = job.result_summary.status;
  if (result === 'complete') return '완료';
  if (result === 'pending_reconcile') return '저장 결과 확인 필요';
  if (job.state === 'cancelled') return '취소됨';
  if (job.reported_status === 'failed') return '실패';
  if (job.reported_status === 'stopped') return '중단됨';
  if (result === 'rejected') return '결과 거부됨';
  if (result === 'partial' && job.lease_status !== 'active') return '일부 완료';
  return null;
}

/** 서버 분석 작업을 복원 후보로 바꿉니다. 끝난 시각을 알 수 없는 작업은 후보가 아닙니다. */
export function restorableFromJob(job: AnalysisJob): FinishedActivity | null {
  const result = finishedAnalysisResult(job);
  const endedAt = lastEventTime(job.events);
  if (result === null || endedAt === null) return null;
  const document = job.targets[0]?.document;
  return {
    kind: 'analysis',
    id: job.job_id,
    endedAt,
    result,
    ...(document ? { document } : {}),
    ...(job.registration?.title ? { title: job.registration.title } : {}),
  };
}

/**
 * 앱이 꺼져 있던 동안 끝난 작업을 서버 기록에서 되살립니다.
 * - 마지막으로 AI 세션을 연 시각(seenAt) 뒤에 끝났고 아직 확인(✕)하지 않은 것만 추가합니다.
 * - 처음 여는 기기(seenAt 없음)는 과거 기록을 쏟아내지 않고 기준 시각만 정합니다.
 * - 조회가 일부만 이뤄졌으면(complete=false) 놓친 작업을 다음에 다시 찾도록 기준 시각을 옮기지 않습니다.
 * 서버 기록은 읽기만 하며 기존 기록을 바꾸거나 지우지 않습니다.
 */
export function restoreFinished(
  scopeKey: string,
  jobs: readonly AnalysisJob[],
  readStartedAt: string,
  complete: boolean,
): void {
  const store = readStore(scopeKey);
  const known = new Set(store.items.map(activityKey));
  const dismissed = new Set(store.dismissed);
  const added: FinishedActivity[] = [];
  if (store.seenAt !== null) {
    const since = Date.parse(store.seenAt);
    for (const job of jobs) {
      const candidate = restorableFromJob(job);
      if (!candidate) continue;
      const key = activityKey(candidate);
      if (
        Date.parse(candidate.endedAt) > since &&
        !known.has(key) &&
        !dismissed.has(key)
      )
        added.push(candidate);
    }
  }
  const seenAt =
    complete || store.seenAt === null ? readStartedAt : store.seenAt;
  if (added.length === 0 && seenAt === store.seenAt) return;
  writeStore(scopeKey, {
    seenAt,
    dismissed: store.dismissed,
    items: [...added, ...store.items],
  });
}
