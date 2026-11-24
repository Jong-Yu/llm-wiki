/** 제품 저장 모델과 구별되는 UI 비교용 합성 작업입니다. */
export type TaskState =
  | 'ready'
  | 'running'
  | 'failed'
  | 'partial'
  | 'unconfirmed'
  | 'complete'
  | 'cancelled';
export type TaskPhase = 'conversion' | 'wiki' | 'ontology' | 'done';
export type TaskAction =
  | 'retry_conversion'
  | 'inspect_execution'
  | 'execute_remaining'
  | 'confirm_result'
  | 'stop';
export type PreviewTask = {
  id: string;
  title: string;
  fileName: string;
  sourceId: string;
  version: string;
  kind: 'document' | 'question';
  state: TaskState;
  phase: TaskPhase;
  updatedAt: string;
  attempt: number;
  completedUnits: number | null;
  totalUnits: number | null;
  savedWiki: string | null;
  errorCode: string | null;
  previousSuccess: string | null;
};

/** 같은 제목·원본·상태를 현재 화면과 제안 화면에 제공합니다. */
export function initialTasks(): PreviewTask[] {
  return [
    {
      id: 'architecture',
      title: '아키텍처 검토 자료',
      fileName: '아키텍처-검토.pdf',
      sourceId: 'b'.repeat(32),
      version: 'c'.repeat(32),
      kind: 'document',
      state: 'failed',
      phase: 'conversion',
      updatedAt: '2026-11-23 10:42',
      attempt: 2,
      completedUnits: 4,
      totalUnits: 170,
      savedWiki: null,
      errorCode: 'worker_failed',
      previousSuccess: null,
    },
    {
      id: 'sensor',
      title: '온도 센서 인터페이스',
      fileName: '온도-센서.pdf',
      sourceId: 'd'.repeat(32),
      version: 'e'.repeat(32),
      kind: 'document',
      state: 'running',
      phase: 'conversion',
      updatedAt: '2026-11-23 10:45',
      attempt: 1,
      completedUnits: 12,
      totalUnits: 36,
      savedWiki: null,
      errorCode: null,
      previousSuccess: null,
    },
    {
      id: 'mode',
      title: '운전 모드 전환',
      fileName: '운전-모드.docx',
      sourceId: 'f'.repeat(32),
      version: 'a'.repeat(32),
      kind: 'document',
      state: 'partial',
      phase: 'ontology',
      updatedAt: '2026-11-23 10:39',
      attempt: 2,
      completedUnits: null,
      totalUnits: null,
      savedWiki: '설계/운전-모드-전환.md',
      errorCode: 'execution_failed',
      previousSuccess: '2026-11-22 16:20',
    },
    {
      id: 'interface',
      title: '제어 인터페이스',
      fileName: '제어-인터페이스.md',
      sourceId: '1'.repeat(32),
      version: '2'.repeat(32),
      kind: 'document',
      state: 'unconfirmed',
      phase: 'wiki',
      updatedAt: '2026-11-23 10:36',
      attempt: 1,
      completedUnits: null,
      totalUnits: null,
      savedWiki: null,
      errorCode: null,
      previousSuccess: null,
    },
    {
      id: 'safety',
      title: '안전 요구사항',
      fileName: '안전-요구사항.md',
      sourceId: '3'.repeat(32),
      version: '4'.repeat(32),
      kind: 'document',
      state: 'complete',
      phase: 'done',
      updatedAt: '2026-11-23 10:30',
      attempt: 1,
      completedUnits: null,
      totalUnits: null,
      savedWiki: '설계/안전-요구사항.md',
      errorCode: null,
      previousSuccess: null,
    },
    {
      id: 'ready',
      title: '통신 규격',
      fileName: '통신-규격.md',
      sourceId: '5'.repeat(32),
      version: '6'.repeat(32),
      kind: 'document',
      state: 'ready',
      phase: 'wiki',
      updatedAt: '2026-11-23 10:28',
      attempt: 1,
      completedUnits: null,
      totalUnits: null,
      savedWiki: null,
      errorCode: null,
      previousSuccess: null,
    },
  ];
}

/** 단계별 상태를 제품에 노출할 문구로 요약합니다. */
export function taskLabel(task: PreviewTask): string {
  if (task.state === 'unconfirmed') return '저장 결과 확인 필요';
  if (task.state === 'cancelled') return '실행 중단됨';
  if (task.state === 'ready') return '실행 전';
  if (task.state === 'complete') return '추출 완료 · 검토 전';
  if (task.state === 'partial') return '문서 저장됨 · 관계 추출 중단';
  if (task.state === 'failed') return '문자 변환 실패';
  return task.phase === 'conversion'
    ? '문자 변환 중'
    : task.phase === 'wiki'
      ? 'Wiki 문서 저장 중'
      : '관계 추출 중';
}

/** 조회와 실행을 분리한 시안의 동일 작업 주소입니다. */
export function taskPath(task: PreviewTask): string {
  return `/tasks?task=${encodeURIComponent(task.id)}`;
}
