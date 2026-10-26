import type { JSX } from 'react';
import { ConfigureRuntime } from '@renderer/features/configure-runtime';
/** 설치 환경 기능의 공개 진입점입니다. */
export function RuntimeSetupPage(): JSX.Element {
  return <ConfigureRuntime />;
}
