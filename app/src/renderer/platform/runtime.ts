import type {
  RuntimeRequest,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
/** 환경 설정 bridge의 검증된 결과만 화면에 전달합니다. */
export async function executeRuntime(
  request: RuntimeRequest,
): Promise<RuntimeSnapshot> {
  if (!window.wiki) throw new Error('데스크톱 앱에서 실행해 주세요.');
  const result = await window.wiki.runtime.execute(request);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
