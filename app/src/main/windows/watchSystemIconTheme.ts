import { nativeTheme } from 'electron';

/** 아이콘에 필요한 OS 색과 변경 구독만 사용하며 이벤트 등록의 반환값에는 의존하지 않습니다. */
export type SystemIconTheme = {
  readonly shouldUseDarkColorsForSystemIntegratedUI: boolean;
  on: (event: 'updated', listener: () => void) => void;
  off: (event: 'updated', listener: () => void) => void;
};

/** 앱 화면 테마와 별개인 OS 표시 영역의 색을 최초 적용하고 변경을 구독합니다. */
export function watchSystemIconTheme(
  apply: (dark: boolean) => void,
  theme: SystemIconTheme = nativeTheme,
): () => void {
  let previous: boolean | undefined;
  const update = (): void => {
    const dark = theme.shouldUseDarkColorsForSystemIntegratedUI;
    if (dark === previous) return;
    apply(dark);
    previous = dark;
  };
  update();
  theme.on('updated', update);
  return (): void => {
    theme.off('updated', update);
  };
}
