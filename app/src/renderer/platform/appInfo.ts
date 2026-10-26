import type { GetAppInfoResponse } from '@contracts/app.contract';

/** renderer가 공개 앱 정보에 접근하는 유일한 bridge adapter입니다. */
export async function getAppInfo(): Promise<GetAppInfoResponse> {
  if (!window.wiki) throw new Error('데스크톱 앱에서 실행해 주세요.');
  const result = await window.wiki.app.getInfo();
  if (!result.ok) throw new Error(result.error.detail);
  return result.data;
}
