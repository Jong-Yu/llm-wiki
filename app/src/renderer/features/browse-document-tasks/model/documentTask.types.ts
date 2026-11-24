export type DocumentTaskState =
  | 'ready'
  | 'running'
  | 'failed'
  | 'partial'
  | 'review'
  | 'unconfirmed'
  | 'complete'
  | 'stopped';

export type DocumentTaskAction =
  | 'refresh'
  | 'retry-conversion'
  | 'stop-conversion'
  | 'prepare'
  | 'execute';
export type DocumentTaskStepState =
  | 'complete'
  | 'current'
  | 'failed'
  | 'waiting'
  | 'ready'
  | 'unconfirmed'
  | 'review'
  | 'stopped';
export type DocumentTaskStep = {
  title: string;
  state: DocumentTaskStepState;
  note: string;
};
export type DocumentTaskResult = {
  document: string;
  title: string;
  ontology: boolean;
  current: boolean;
};
export type DocumentTaskAttemptView = {
  id: string;
  title: string;
  state: string;
  startedAt: string | null;
  message: string;
  codes: readonly string[];
};

/** 조회한 기록을 화면에만 투영하며 저장·실행 payload로 되돌리지 않습니다. */
export type DocumentTaskView = {
  id: string;
  title: string;
  fileName: string;
  sourceId: string;
  sourceVersion: string;
  updatedAt: string;
  attemptCount: number;
  state: DocumentTaskState;
  status: string;
  progress: string | null;
  jobId: string | null;
  steps: readonly DocumentTaskStep[];
  explanation: { title: string; body: string; next: string };
  results: readonly DocumentTaskResult[];
  hasPreviousResults: boolean;
  attempts: readonly DocumentTaskAttemptView[];
  warnings: readonly string[];
  textReviewScopes: readonly string[];
  textReviewUnits: readonly { label: string; content: string }[];
  primaryAction: { id: DocumentTaskAction; label: string } | null;
};

export type DocumentTaskStatusFilter =
  | 'all'
  | 'running'
  | 'attention'
  | 'ready'
  | 'complete';

/** 열람·읽음 여부는 해결이 필요한 상태의 판정에 사용하지 않습니다. */
export function documentTaskNeedsAttention(task: DocumentTaskView): boolean {
  return (
    task.textReviewScopes.length > 0 ||
    ['failed', 'partial', 'review', 'unconfirmed', 'stopped'].includes(
      task.state,
    )
  );
}

/** 목록 필터는 상태를 바꾸지 않고 표시 범위만 좁힙니다. */
export function matchesDocumentTaskStatus(
  task: DocumentTaskView,
  filter: DocumentTaskStatusFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return documentTaskNeedsAttention(task);
  return task.state === filter;
}
