import type {
  AiActivity,
  AccountUsage,
  AccountUsageWindow,
} from '@contracts/aiSessions.contract';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import type { SessionItem } from '../api/aiSessions.api';

/** 여러 한도 중 잔여량이 가장 적은 실제 창을 헤더 대표값으로 사용합니다. */
export function primaryUsageWindow(
  usage: AccountUsage | undefined,
): AccountUsageWindow | null {
  if (!usage || usage.status !== 'available') return null;
  return usage.windows.reduce<AccountUsageWindow | null>(
    (
      selected: AccountUsageWindow | null,
      item: AccountUsageWindow,
    ): AccountUsageWindow =>
      !selected || item.remainingPercent < selected.remainingPercent
        ? item
        : selected,
    null,
  );
}

/** 세션 종류와 대상 식별자로만 이동 주소를 만들고 이동 중 실행하지 않습니다. */
export function activityLocation(activity: AiActivity): string | null {
  if (activity.kind === 'analysis')
    return `/jobs?jobId=${encodeURIComponent(activity.id)}`;
  if (activity.kind === 'question')
    return activity.conversationId
      ? `/chat?conversationId=${encodeURIComponent(activity.conversationId)}&questionRunId=${encodeURIComponent(activity.id)}`
      : null;
  if (activity.kind === 'comparison')
    return `/sessions?comparisonId=${encodeURIComponent(activity.id)}${activity.document ? `&document=${encodeURIComponent(activity.document)}` : ''}`;
  return activity.proposalId
    ? `/analysis-proposals?proposalId=${encodeURIComponent(activity.proposalId)}${activity.document ? `&document=${encodeURIComponent(activity.document)}` : ''}`
    : null;
}

/** 생성 시각이 최신인 기록을 앞에 두며 시각이 없는 기록은 뒤에 둡니다. */
export function newestFirst<T extends { createdAt?: string }>(items: T[]): T[] {
  const time = (item: T): number => {
    const parsed = item.createdAt ? Date.parse(item.createdAt) : Number.NaN;
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...items].sort((a: T, b: T): number => {
    const left = time(a);
    const right = time(b);
    return left === right ? 0 : left < right ? 1 : -1;
  });
}

/** 실제 시각만 공통 형식으로 표시하고 미제공 상태를 유지합니다. */
export function usageTime(value: string | null): string {
  if (value === null) return '미제공';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '미제공' : formatTimestamp(value);
}

/** 초기화 시각이 있을 때만 "MM.DD" 형식으로 줄여 표시합니다. */
export function resetDateLabel(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${month}.${day}`;
}

/** 작업 종류의 화면 이름입니다. */
export function kindLabel(kind: AiActivity['kind']): string {
  if (kind === 'analysis') return '문서 분석';
  if (kind === 'question') return 'AI 질문';
  if (kind === 'comparison') return '관련 지식 찾기';
  return '관계 재추출';
}

/** 시작하지 않은 분석은 세션이 아니므로 목록에서 뺍니다. */
export function notStarted(item: SessionItem): boolean {
  return item.kind === 'analysis' && item.status === '실행 대기';
}
