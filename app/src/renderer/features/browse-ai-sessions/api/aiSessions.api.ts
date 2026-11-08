import type { AnalysisJob } from '@contracts/analysis.contract';
import type {
  QuestionSession,
  QuestionDetail,
} from '@contracts/questionRuns.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import { analysisGateway } from '@renderer/platform/analysis';
import { questionRunsGateway } from '@renderer/platform/questionRuns';
import { knowledgeComparisonsGateway } from '@renderer/platform/knowledgeComparisons';
import { connectionGateway } from '@renderer/platform/connection';

export type SessionItem = {
  id: string;
  kind: 'analysis' | 'question' | 'comparison';
  title: string;
  status: string;
  target: string;
  href: string | null;
  /** 서버가 기록한 생성 시각이며 없으면 표시하지 않습니다. */
  createdAt?: string;
};
export type SessionFilter = {
  sourceId: string | null;
  sourceVersion: string | null;
  document: string | null;
};
export type SessionCursors = {
  analysis: string | null;
  question: string | null;
  comparison: string | null;
};
export type SessionPage = {
  items: SessionItem[];
  cursors: SessionCursors;
  hasGaps: boolean;
  incomplete: boolean;
  messages: string[];
};

/** 접근 거부는 부분 조회와 분리해 이미 표시한 목록도 숨기도록 전달합니다. */
export class SessionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionScopeError';
  }
}

/** 응답·예외의 명시 권한 오류만 분류하며 일반 연결 장애를 권한 변경으로 추정하지 않습니다. */
export function throwIfScopeError(value: unknown): void {
  if (value instanceof SessionScopeError) throw value;
  if (!value || typeof value !== 'object') return;
  const code =
    'code' in value && typeof value.code === 'string' ? value.code : '';
  const status =
    'status' in value && typeof value.status === 'number' ? value.status : null;
  if (
    status !== 401 &&
    status !== 403 &&
    ![
      'forbidden',
      'unauthorized',
      'scope_changed',
      'connection_changed',
      'access_changed',
      'policy_changed',
      'connection_required',
    ].includes(code)
  )
    return;
  throw new SessionScopeError(
    'message' in value && typeof value.message === 'string'
      ? value.message
      : '접근 범위가 변경되었습니다. 현재 연결을 다시 확인해 주세요.',
  );
}

/** 공개 연결 상태에서 현재 인증 주체와 관점을 고정합니다. */
export async function readSessionScope(): Promise<QuestionSession> {
  const result = await connectionGateway
    .getState()
    .catch((cause: unknown): never => {
      throwIfScopeError(cause);
      throw cause;
    });
  if (!result.ok) {
    throwIfScopeError(result.error);
    throw new Error(result.error.message);
  }
  const state = result.data;
  if (state.status !== 'connected' || !state.selection)
    throw new SessionScopeError('작업 공간에 연결한 뒤 다시 확인해 주세요.');
  const membership = state.workspaces.find(
    (item: (typeof state.workspaces)[number]): boolean =>
      item.id === state.selection?.tenant,
  );
  if (!membership?.permissions.includes('read'))
    throw new SessionScopeError(
      '현재 작업 공간의 조회 권한을 확인할 수 없습니다.',
    );
  return {
    connectionId: state.connectionId,
    expectedScope: {
      userId: state.userId,
      tenant: state.selection.tenant,
      profileId: state.selection.profile,
      policyRevision: state.policyRevision,
      ...(state.accessRevision ? { accessRevision: state.accessRevision } : {}),
    },
  };
}

/** 늦게 도착한 응답을 다른 계정·공간의 현재 결과로 표시하지 않습니다. */
export async function assertSessionScope(
  scope: QuestionSession,
): Promise<void> {
  const current = await readSessionScope();
  if (
    scope.connectionId !== current.connectionId ||
    scope.expectedScope.userId !== current.expectedScope.userId ||
    scope.expectedScope.tenant !== current.expectedScope.tenant ||
    scope.expectedScope.profileId !== current.expectedScope.profileId ||
    !sameAccessRevision(scope.expectedScope, current.expectedScope)
  )
    throw new SessionScopeError(
      '연결 또는 작업 공간이 변경되었습니다. 현재 범위에서 다시 조회해 주세요.',
    );
}

/** 작업 영수증·서버 보고·대기 상태를 구분하고 조회만으로 실행을 시작하지 않습니다. */
export function analysisStatus(job: AnalysisJob): string {
  const result = job.result_summary.status;
  if (result === 'pending_reconcile') return '저장 결과 확인 필요';
  if (result === 'complete') return '완료';
  if (job.state === 'cancelled') return '취소됨';
  if (job.reported_status === 'failed') return '실패';
  if (job.reported_status === 'stopped') return '중단됨';
  if (job.reported_status === 'blocked') return '진행 조건 확인 필요';
  if (job.lease_status === 'active') return '실행 중';
  if (result === 'partial') return '일부 완료';
  if (result === 'rejected') return '결과 거부됨';
  return job.state === 'awaiting_cli' ? '실행 대기' : '진행 확인 필요';
}

/** 질문의 저장 미확인 상태를 일반 완료와 구분합니다. */
export function questionStatus(detail: QuestionDetail): string {
  if (
    detail.receipts.some(
      (receipt: QuestionDetail['receipts'][number]): boolean =>
        receipt.state === 'pending_reconcile' || receipt.saved === null,
    ) ||
    (detail.local.requestId !== null &&
      !detail.receipts.some(
        (receipt: QuestionDetail['receipts'][number]): boolean =>
          receipt.request_id === detail.local.requestId &&
          receipt.saved !== null,
      ))
  )
    return '저장 결과 확인 필요';
  if (detail.local.status === 'stopping') return '중단 중';
  if (
    detail.local.status === 'running' ||
    (detail.status === 'running' && detail.leaseStatus === 'active')
  )
    return '실행 중';
  if (detail.status === 'running') return '진행 확인 필요';
  const labels: Record<QuestionDetail['status'], string> = {
    queued: '실행 대기',
    running: '실행 중',
    complete: '완료',
    failed: '실패',
    cancelled: '취소됨',
  };
  return labels[detail.status];
}

/** 관련 지식 찾기 기록의 상태를 화면 이름으로 바꿉니다. */
function comparisonStatus(
  status: 'running' | 'complete' | 'incomplete',
): string {
  if (status === 'running') return '실행 중';
  return status === 'complete' ? '완료' : '일부 완료';
}

/** 서버에 저장된 분석과 질문의 한 페이지를 읽고 각각의 불완전 범위를 남깁니다. */
export async function readSessionPage(
  scope: QuestionSession,
  filter: SessionFilter,
  cursors: SessionCursors | null,
): Promise<SessionPage> {
  const items: SessionItem[] = [];
  const messages: string[] = [];
  const next: SessionCursors = {
    analysis: null,
    question: null,
    comparison: null,
  };
  let hasGaps = false;
  const includeQuestions = !filter.sourceId && !filter.document;
  const results = await Promise.allSettled([
    cursors === null || cursors.analysis
      ? analysisGateway.list({
          connectionId: scope.connectionId,
          sourceId: filter.sourceId,
          cursor: cursors?.analysis ?? null,
        })
      : Promise.resolve(null),
    includeQuestions && (cursors === null || cursors.question)
      ? questionRunsGateway.list({
          ...scope,
          cursor: cursors?.question ?? null,
        })
      : Promise.resolve(null),
    includeQuestions && (cursors === null || cursors.comparison)
      ? knowledgeComparisonsGateway.list({
          ...scope,
          document: null,
          jobId: null,
          cursor: cursors?.comparison ?? null,
        })
      : Promise.resolve(null),
  ]);
  // 한 목록의 접근 거부를 다른 목록의 성공이나 이전 페이지로 가리지 않습니다.
  for (const result of results) {
    if (result.status === 'rejected') throwIfScopeError(result.reason);
    else if (result.value?.ok === false) throwIfScopeError(result.value.error);
  }
  const analyses = results[0];
  if (analyses.status === 'fulfilled' && analyses.value?.ok) {
    const page = analyses.value.data;
    next.analysis = page.requiresRefresh ? null : page.nextCursor;
    hasGaps ||=
      (!page.complete && page.nextCursor === null) ||
      page.truncated ||
      page.skippedCount > 0 ||
      page.requiresRefresh;
    if (page.requiresRefresh)
      messages.push(
        '분석 목록이 변경되었습니다. 새로고침해 다시 확인해 주세요.',
      );
    if (page.skippedCount)
      messages.push(`읽지 못한 분석 작업 ${page.skippedCount}개`);
    for (const job of page.items) {
      if (
        filter.sourceVersion &&
        job.source_ref.source_version !== filter.sourceVersion
      )
        continue;
      if (
        filter.document &&
        !job.targets.some(
          (target: AnalysisJob['targets'][number]): boolean =>
            target.document === filter.document,
        )
      )
        continue;
      items.push({
        id: job.job_id,
        kind: 'analysis',
        title:
          job.registration?.title ??
          (job.targets
            .map(
              (target: AnalysisJob['targets'][number]): string =>
                target.document,
            )
            .join(', ') ||
            '원본 분석'),
        status: analysisStatus(job),
        target:
          job.targets
            .map(
              (target: AnalysisJob['targets'][number]): string =>
                target.document,
            )
            .join(', ') || '등록 원본',
        href: `/jobs?jobId=${encodeURIComponent(job.job_id)}`,
        createdAt: job.created_at,
      });
    }
  } else if (analyses.status === 'rejected' || analyses.value?.ok === false) {
    hasGaps = true;
    messages.push(
      analyses.status === 'fulfilled' && analyses.value?.ok === false
        ? analyses.value.error.message
        : '분석 작업 목록을 읽지 못했습니다.',
    );
  }
  const questions = results[1];
  if (questions.status === 'fulfilled' && questions.value?.ok) {
    const page = questions.value.data;
    next.question = page.nextCursor;
    // 현재 질문 계약의 incomplete는 complete/truncated/skipped만 반영하며 커서는 별도입니다.
    hasGaps ||= page.incomplete;
    // 많은 작업을 한꺼번에 재조회하지 않도록 상세 읽기의 동시 수를 제한합니다.
    for (let offset = 0; offset < page.items.length; offset += 4) {
      const group = page.items.slice(offset, offset + 4);
      const details = await Promise.allSettled(
        group.map(
          async (item: (typeof page.items)[number]): Promise<SessionItem> => {
            const result = await questionRunsGateway.read({
              ...scope,
              questionRunId: item.id,
            });
            if (!result.ok) {
              throwIfScopeError(result.error);
              return {
                id: item.id,
                kind: 'question',
                title: item.title,
                status: '대상 확인 불가',
                target: result.error.message,
                href: null,
                createdAt: item.created_at,
              };
            }
            return {
              id: item.id,
              kind: 'question',
              title: result.data.question,
              status: questionStatus(result.data),
              target: 'AI 대화',
              href: `/chat?conversationId=${encodeURIComponent(result.data.conversationId)}&questionRunId=${item.id}`,
              createdAt: item.created_at,
            };
          },
        ),
      );
      details.forEach(
        (result: PromiseSettledResult<SessionItem>, index: number): void => {
          if (result.status === 'fulfilled') {
            items.push(result.value);
            hasGaps ||= result.value.href === null;
          } else {
            throwIfScopeError(result.reason);
            const item = group[index];
            if (item)
              items.push({
                id: item.id,
                kind: 'question',
                title: item.title,
                status: '조회 실패',
                target: '현재 연결을 확인한 뒤 다시 조회해 주세요.',
                href: null,
                createdAt: item.created_at,
              });
            hasGaps = true;
          }
        },
      );
    }
  } else if (questions.status === 'rejected' || questions.value?.ok === false) {
    hasGaps = true;
    messages.push(
      questions.status === 'fulfilled' && questions.value?.ok === false
        ? questions.value.error.message
        : '질문 작업 목록을 읽지 못했습니다.',
    );
  }
  const comparisons = results[2];
  if (comparisons.status === 'fulfilled' && comparisons.value?.ok) {
    const page = comparisons.value.data;
    next.comparison = page.nextCursor;
    // 이어 읽을 커서가 있으면 "더 불러오기"로 해결되므로 빠진 자료로 세지 않습니다.
    const unreadable = page.incomplete && page.nextCursor === null;
    hasGaps ||= unreadable;
    if (unreadable)
      messages.push('관련 지식 찾기 기록 일부를 읽지 못했습니다.');
    for (const item of page.items)
      items.push({
        id: item.id,
        kind: 'comparison',
        title: item.document,
        status: comparisonStatus(item.status),
        target: item.document,
        href: `/sessions?comparisonId=${encodeURIComponent(item.id)}&document=${encodeURIComponent(item.document)}`,
        createdAt: item.created_at,
      });
  } else if (
    comparisons.status === 'rejected' ||
    comparisons.value?.ok === false
  ) {
    hasGaps = true;
    messages.push('관련 지식 찾기 기록을 읽지 못했습니다.');
  }
  await assertSessionScope(scope);
  return {
    items,
    cursors: next,
    hasGaps,
    incomplete:
      hasGaps ||
      next.analysis !== null ||
      next.question !== null ||
      next.comparison !== null,
    messages,
  };
}
