import { useCallback, useEffect, useRef, useState } from 'react';
import { readImportScope } from '../api/importRegistration.api';
import type { ImportScopeResult } from '../api/importRegistration.api';

type ScopeState = ImportScopeResult | { status: 'loading' };
type ImportScopeModel = { state: ScopeState; refresh: () => void };

/** 현재 앱 선택을 읽고 재진입·창 복귀 시에도 다른 범위의 입력을 숨깁니다. */
export function useImportScope(): ImportScopeModel {
  const [state, setState] = useState<ScopeState>({ status: 'loading' });
  const generation = useRef(0);
  const refresh = useCallback((): void => {
    const current = ++generation.current;
    void readImportScope().then((result: ImportScopeResult): void => {
      if (current === generation.current) setState(result);
    });
  }, []);
  useEffect((): (() => void) => {
    refresh();
    window.addEventListener('focus', refresh);
    return (): void => {
      generation.current += 1;
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return { state, refresh };
}
