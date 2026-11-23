/** 문서 처리 작업의 주소는 재실행 명령과 분리된 안정 식별자만 포함합니다. */
export function documentTaskPath(taskId: string): string {
  return `/tasks?${new URLSearchParams({ taskId })}`;
}

/** 작업과 결과 사이의 복귀는 허용된 앱 화면으로만 제한합니다. */
export function workflowReturnTo(state: unknown): string | null {
  if (!state || typeof state !== 'object' || !('workflowReturnTo' in state))
    return null;
  const value = state.workflowReturnTo;
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^\/(?:tasks|documents|source|jobs|sessions)(?:\?[^#\\]*)?$/.test(value)
  )
    return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return null;
  }
  return value;
}
