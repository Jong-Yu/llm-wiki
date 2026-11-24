import type { JSX } from 'react';
import { TaskActivity } from './TaskScreens';
import { usePreviewTasks } from './previewStore';
/** 실제 상태바 자리에 동일한 모의 작업의 요약을 연결합니다. */
export function PreviewActivity(): JSX.Element {
  const tasks = usePreviewTasks();
  return <TaskActivity tasks={tasks} />;
}
