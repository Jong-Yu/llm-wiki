import { useEffect, useSyncExternalStore } from 'react';

/** 라우트 안의 화면이 알려 준 현재 제목을 키별로 보관하는 작은 외부 저장소입니다. */
type Entry = { owner: symbol; title: string };

let entries: ReadonlyMap<string, string> = new Map();
const owners = new Map<string, Entry>();
const listeners = new Set<() => void>();

function publish(): void {
  entries = new Map(
    [...owners].map(([key, entry]: [string, Entry]): [string, string] => [
      key,
      entry.title,
    ]),
  );
  listeners.forEach((listener: () => void): void => listener());
}

/** 문서 상세가 제목을 알리는 키입니다. 추출 비교도 같은 문서 키를 조회합니다. */
export function documentTitleKey(path: string): string {
  return `document:${path}`;
}

/** 원본 상세가 제목을 알리는 키입니다. */
export function sourceTitleKey(sourceId: string): string {
  return `source:${sourceId}`;
}

/** 산출물이 제목을 알리는 키입니다. */
export function artifactTitleKey(artifactId: string): string {
  return `artifact:${artifactId}`;
}

/** 화면 쪽: 제목이 있을 때만 알리고, 언마운트·키 변경 때 자기 항목만 해제합니다. */
export function useRouteTitle(key: string, title: string | null): void {
  useEffect((): (() => void) | undefined => {
    if (!title) return undefined;
    const owner = Symbol(key);
    owners.set(key, { owner, title });
    publish();
    return (): void => {
      // 같은 키를 나중에 알린 다른 화면의 제목은 지우지 않습니다.
      if (owners.get(key)?.owner !== owner) return;
      owners.delete(key);
      publish();
    };
  }, [key, title]);
}

/** 앱 틀 쪽: 알려진 제목 전체를 읽습니다. 현재 주소의 키만 조회해 숨겨진 화면이 덮어쓰지 않게 합니다. */
export function useRouteTitles(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (listener: () => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    (): ReadonlyMap<string, string> => entries,
  );
}
