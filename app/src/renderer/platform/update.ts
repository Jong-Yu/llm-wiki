import type { UpdateStatus } from '@contracts/update.contract';

/** 업데이트 bridge가 없는 환경(웹 테스트 등)에서는 항상 변화 없음으로 봅니다. */
export async function readUpdateStatus(): Promise<UpdateStatus> {
  const result = await window.wiki?.update?.getStatus();
  return result?.ok ? result.data : { state: 'idle' };
}

/** 내려받은 업데이트를 설치하며 앱이 종료되기 전에 실패하면 오류를 던집니다. */
export async function installUpdate(): Promise<void> {
  const result = await window.wiki?.update?.install();
  if (result && !result.ok) throw new Error(result.error.message);
}
