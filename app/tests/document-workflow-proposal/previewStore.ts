import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { SourceFile } from '@contracts/sources.contract';
import { initialTasks, taskLabel, taskPath } from './model';
import type { PreviewTask, TaskAction } from './model';

export const proposed =
  new URLSearchParams(location.search).get('mode') !== 'before';
const comparisonKey = 'llm-wiki.document-workflow-proposal.comparison.v1';
const comparisonSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        fileName: z.string(),
        sourceId: z.string(),
        version: z.string(),
        kind: z.enum(['document', 'question']),
        state: z.enum([
          'ready',
          'running',
          'failed',
          'partial',
          'unconfirmed',
          'complete',
          'cancelled',
        ]),
        phase: z.enum(['conversion', 'wiki', 'ontology', 'done']),
        updatedAt: z.string(),
        attempt: z.number(),
        completedUnits: z.number().nullable(),
        totalUnits: z.number().nullable(),
        savedWiki: z.string().nullable(),
        errorCode: z.string().nullable(),
        previousSuccess: z.string().nullable(),
      }),
    )
    .max(100),
  actions: z.number().int().nonnegative(),
});
/** 비교 버튼으로 넘긴 합성 상태만 한 번 복원하며 제품 복원과 구분합니다. */
function takeComparison(): { tasks: PreviewTask[]; actions: number } {
  try {
    const raw = sessionStorage.getItem(comparisonKey);
    sessionStorage.removeItem(comparisonKey);
    if (raw) {
      const parsed = comparisonSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch {
    /* 탭 저장소가 없는 환경에서는 초기 예시를 사용합니다. */
  }
  return { tasks: initialTasks(), actions: 0 };
}
const comparison = takeComparison();
let tasks = comparison.tasks;
const listeners = new Set<() => void>();
let actionCount = comparison.actions;

export function rememberComparison(): void {
  sessionStorage.setItem(
    comparisonKey,
    JSON.stringify({ tasks, actions: actionCount }),
  );
}

/** 시안은 메모리에만 있으며 운영 저장소·API를 사용하지 않습니다. */
export function readTasks(): PreviewTask[] {
  return tasks;
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
export function usePreviewTasks(): PreviewTask[] {
  return useSyncExternalStore(subscribe, readTasks);
}
export function resetPreview(): void {
  tasks = initialTasks();
  actionCount = 0;
  listeners.forEach((listener: () => void): void => listener());
}
export function previewActionCount(): number {
  return actionCount;
}
export function applyPreviewAction(id: string, action: TaskAction): string {
  actionCount += 1;
  if (action === 'inspect_execution')
    return '실행 조건을 확인했습니다. 저장된 문서는 유지하고 미완료 단계만 실행할 수 있습니다.';
  tasks = tasks.map((task: PreviewTask): PreviewTask => {
    if (task.id !== id) return task;
    if (action === 'retry_conversion')
      return {
        ...task,
        state: 'running',
        phase: 'conversion',
        attempt: task.attempt + 1,
        completedUnits: 0,
        errorCode: null,
      };
    if (action === 'execute_remaining')
      return {
        ...task,
        state: 'running',
        phase: task.savedWiki ? 'ontology' : 'wiki',
        errorCode: null,
      };
    if (action === 'stop') return { ...task, state: 'cancelled' };
    return {
      ...task,
      state: 'ready',
      phase: 'ontology',
      savedWiki: `설계/${task.title.replaceAll(' ', '-')}.md`,
    };
  });
  listeners.forEach((listener: () => void): void => listener());
  if (action === 'confirm_result')
    return '원래 요청의 문서 저장을 확인했습니다. 새 저장 요청은 보내지 않았습니다.';
  if (action === 'stop')
    return '이 기기의 실행을 중단했습니다. 보관된 원본과 저장 결과는 유지됩니다.';
  return action === 'retry_conversion'
    ? '보관된 원본을 처음부터 다시 변환합니다. 원본을 새로 등록하지 않습니다.'
    : '확인한 미완료 단계의 실행을 시작했습니다.';
}
export function sourceTask(sourceId: string): PreviewTask | undefined {
  return tasks.find((task: PreviewTask): boolean => task.sourceId === sourceId);
}
export function sourceTaskLabel(sourceId: string): string {
  const task = sourceTask(sourceId);
  return task ? taskLabel(task) : '상태 확인 필요';
}
export function sourceTaskPath(sourceId: string): string {
  const task = sourceTask(sourceId);
  return task ? taskPath(task) : '/tasks';
}

/** 접수 뒤 새 작업으로 이동하는 흐름만 모의하며 기존 작업은 유지합니다. */
export function registerPreview(
  title: string,
  file: SourceFile | null,
): PreviewTask {
  const index = tasks.length + 1;
  const task: PreviewTask = {
    ...initialTasks()[1]!,
    id: `registered-${index}`,
    title,
    fileName: file?.filename ?? `${title}.txt`,
    sourceId: index.toString(16).padStart(32, '0'),
    version: '7'.repeat(32),
    state: 'running',
    phase: file && !['md', 'txt'].includes(file.format) ? 'conversion' : 'wiki',
    completedUnits: null,
    totalUnits: null,
    updatedAt: '2026-11-23 10:46',
  };
  tasks = [task, ...tasks];
  listeners.forEach((listener: () => void): void => listener());
  return task;
}

/** 테스트에서 조회와 실행을 구분해 관찰할 공개 시안 상태입니다. */
Reflect.set(window, '__workflowPreview', {
  readTasks,
  previewActionCount,
  resetPreview,
});
