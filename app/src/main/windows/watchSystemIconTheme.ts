import { nativeTheme } from 'electron';
import type { NativeTheme } from 'electron';

export type SystemIconTheme = Pick<
  NativeTheme,
  'on' | 'off' | 'shouldUseDarkColorsForSystemIntegratedUI'
>;

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
