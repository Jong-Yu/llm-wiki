import { useEffect, useState } from 'react';
import { getAppInfo } from '@renderer/platform/appInfo';
import type { GetAppInfoResponse } from '@contracts/app.contract';

type AppInfoState = {
  info: GetAppInfoResponse | null;
  error: string | null;
};

/** 앱 시작 시 공개 실행 정보를 읽습니다. 서버 조회나 업무 캐시가 아닙니다. */
export function useAppInfo(): AppInfoState {
  const [info, setInfo] = useState<GetAppInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let active = true;
    void getAppInfo().then(
      (response: GetAppInfoResponse): void => {
        if (active) setInfo(response);
      },
      (failure: unknown): void => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : '앱 정보를 읽을 수 없습니다.',
          );
      },
    );
    return (): void => {
      active = false;
    };
  }, []);

  return { info, error };
}
