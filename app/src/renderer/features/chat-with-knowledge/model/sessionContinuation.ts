type ContinuationState = {
  messages: number;
  working: boolean;
  unavailable: boolean;
  resumable: boolean | null;
  restarted: boolean;
  replaying: boolean;
};
/** 로컬 세션과 위키에 저장된 대화 이력은 별개다. 현재 또는 다음 전송 한 가지에 대해서만 안내한다. */
export function sessionContinuationHint({
  messages,
  working,
  unavailable,
  resumable,
  restarted,
  replaying,
}: ContinuationState): string | null {
  if (!messages || unavailable) return null;
  if (restarted && working)
    return 'AI 세션이 끊겨 저장된 대화를 다시 보내고 있어요. 토큰이 더 쓰일 수 있어요.';
  if (working && replaying)
    return '새 AI 세션에 저장된 대화를 다시 전달하고 있어요. 토큰이 더 쓰일 수 있어요.';
  if (!working && resumable === false)
    return `다음 질문을 보내면 이전 메시지 ${messages}개를 AI에 다시 전달해요. 토큰이 더 쓰일 수 있어요.`;
  if (!working && restarted)
    return 'AI 세션을 다시 시작하면서 저장된 대화를 함께 보냈어요. 토큰이 더 쓰였을 수 있어요.';
  return null;
}
