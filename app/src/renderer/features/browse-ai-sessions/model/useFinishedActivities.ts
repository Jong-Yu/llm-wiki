import { useCallback, useEffect, useState } from 'react';
import {
  readFinishedScope,
  restoreFinishedFromServer,
} from '../api/finishedRestore.api';
import {
  dismissFinished,
  readFinished,
  subscribeFinished,
} from './finishedActivities';
import type { FinishedActivity } from './finishedActivities';

type FinishedState = {
  items: FinishedActivity[];
  dismiss: (item: FinishedActivity) => void;
};

/**
 * 현재 사용자·공간의 확인 전 끝난 작업을 읽습니다.
 * 화면을 열 때 서버 작업 기록으로 앱이 꺼진 사이 끝난 작업을 복원하고, 연결이 바뀌면 다시 읽습니다.
 * 지금 돌고 있는 작업은 화면이 "끝난 작업"에서 제외합니다.
 */
export function useFinishedActivities(): FinishedState {
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [items, setItems] = useState<FinishedActivity[]>([]);
  useEffect((): (() => void) => {
    let alive = true;
    const load = (restore: boolean): void => {
      readFinishedScope().then(
        ({ key }: { key: string }): void => {
          if (!alive) return;
          setScopeKey(key);
          setItems(readFinished(key));
          if (!restore) return;
          // 복원은 서버 읽기이며 실패해도 이미 있는 기록은 그대로 둡니다.
          restoreFinishedFromServer().then(
            (): void => {
              if (alive) setItems(readFinished(key));
            },
            (): void => undefined,
          );
        },
        (): void => {
          if (!alive) return;
          setScopeKey(null);
          setItems([]);
        },
      );
    };
    load(true);
    const stop = subscribeFinished((): void => load(false));
    const changed = (): void => load(true);
    window.addEventListener('wiki-connection-changed', changed);
    return (): void => {
      alive = false;
      stop();
      window.removeEventListener('wiki-connection-changed', changed);
    };
  }, []);
  const dismiss = useCallback(
    (item: FinishedActivity): void => {
      if (scopeKey) dismissFinished(scopeKey, item);
    },
    [scopeKey],
  );
  return { items, dismiss };
}
