import { useSyncExternalStore } from 'react';
import { designThemes } from './tokens';
import type { DesignTheme, Theme } from './tokens';

export type ThemePreference = Theme | 'system';
export type ResolvedTheme = Theme;
type ThemePreferenceState = {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
};

const storageKey = 'llm-wiki.theme-preference';
const listeners = new Set<() => void>();
// 저장소를 쓸 수 없어도 실행 중에는 선택이 유지되도록 메모리 값을 먼저 둡니다.
let current: ThemePreference | null = null;

/** 저장된 값이 허용된 선택인지 검증합니다. */
function isThemePreference(value: unknown): value is ThemePreference {
  return (
    value === 'system' ||
    designThemes.some((theme: DesignTheme): boolean => theme.value === value)
  );
}

/** 브라우저 저장소 접근은 차단될 수 있어 실패하면 기본값 '시스템'을 씁니다. */
function readPreference(): ThemePreference {
  if (current !== null) return current;
  try {
    const stored: unknown = window.localStorage.getItem(storageKey);
    current = isThemePreference(stored) ? stored : 'system';
  } catch {
    current = 'system';
  }
  return current;
}

/** 모든 구독자에게 바뀐 선택을 알립니다. */
function emit(): void {
  listeners.forEach((listener: () => void): void => listener());
}

/** 선택을 저장하고 알립니다. 저장 실패는 무시하고 이번 실행에는 적용합니다. */
function writePreference(next: ThemePreference): void {
  current = next;
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    // 저장소를 쓸 수 없으면 다음 실행에는 유지되지 않을 뿐 동작은 같습니다.
  }
  emit();
}

/** 같은 창의 변경과 다른 창의 저장 변경을 구독합니다. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== storageKey && event.key !== null) return;
    current = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return (): void => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** 공통 토큰에 등록된 화면 테마와 시스템 선택을 읽고 바꿉니다. */
export function useThemePreference(): ThemePreferenceState {
  const preference = useSyncExternalStore(
    subscribe,
    readPreference,
    (): ThemePreference => 'system',
  );
  return { preference, setPreference: writePreference };
}

function subscribeSystem(listener: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', listener);
  return (): void => media.removeEventListener('change', listener);
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** '시스템' 선택을 운영체제 설정에 따라 라이트/다크로 풀어 줍니다. */
export function useResolvedTheme(): ResolvedTheme {
  const { preference } = useThemePreference();
  const system = useSyncExternalStore(
    subscribeSystem,
    systemTheme,
    (): ResolvedTheme => 'light',
  );
  return preference === 'system' ? system : preference;
}
