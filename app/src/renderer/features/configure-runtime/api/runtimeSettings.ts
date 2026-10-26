import type {
  RuntimeRequest,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import { executeRuntime } from '@renderer/platform/runtime';
/** 개인 실행 환경의 제한된 설정·진단 요청입니다. */
export function runtimeSettingsRequest(
  request: RuntimeRequest,
): Promise<RuntimeSnapshot> {
  return executeRuntime(request);
}
