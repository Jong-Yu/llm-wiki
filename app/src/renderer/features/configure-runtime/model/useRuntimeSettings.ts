import { useEffect, useState } from 'react';
import type {
  RuntimeSnapshot,
  RuntimeRequest,
} from '@contracts/runtime.contract';
import { runtimeSettingsRequest } from '../api/runtimeSettings';

/** 설치 환경 요청의 상태와 화면 수명을 관리합니다. */
export function useRuntimeSettings(): {
  state: RuntimeSnapshot | null;
  busy: boolean;
  error: string | null;
  run: (request: RuntimeRequest) => Promise<void>;
} {
  const [state, setState] = useState<RuntimeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) => {
    let active = true;
    void runtimeSettingsRequest({ operation: 'read' }).then(
      (value: RuntimeSnapshot): void => {
        if (active) setState(value);
      },
      (): void => {
        if (active) setError('실행 환경 정보를 읽지 못했습니다.');
      },
    );
    return (): void => {
      active = false;
    };
  }, []);
  /** 결과는 선택 경로와 진단만 갱신하며 AI 작업을 시작하지 않습니다. */
  async function run(request: RuntimeRequest): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setState(await runtimeSettingsRequest(request));
    } catch (failure: unknown) {
      setError(
        failure instanceof Error
          ? failure.message
          : '환경 요청을 완료하지 못했습니다.',
      );
    } finally {
      setBusy(false);
    }
  }
  return { state, busy, error, run };
}
