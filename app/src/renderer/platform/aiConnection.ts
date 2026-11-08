import { createUseAiConnection } from '@renderer/shared/lib/useAiConnection';
import { executeRuntime } from './runtime';

/** 읽기 전용 'read'로 선택한 AI의 연결 상태를 확인하는 공용 훅입니다(사용법은 shared/lib/useAiConnection.ts). */
export const useAiConnection = createUseAiConnection(
  (): ReturnType<typeof executeRuntime> =>
    executeRuntime({ operation: 'read' }),
);
