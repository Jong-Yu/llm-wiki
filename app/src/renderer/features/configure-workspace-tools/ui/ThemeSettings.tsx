import { useId } from 'react';
import type { JSX } from 'react';
import { designThemes, designTokens } from '../../../shared/theme/tokens';
import type { DesignTheme } from '../../../shared/theme/tokens';
import type { ThemePreference } from '../../../shared/theme/useThemePreference';
import styles from './WorkspaceTools.module.scss';

export type ThemePreferenceValue = ThemePreference;
type ThemeSettingsProps = {
  preference: ThemePreferenceValue;
  onChange: (next: ThemePreferenceValue) => void;
};
type ThemeOption = {
  value: ThemePreferenceValue;
  label: string;
  preview: string;
};
const options: ThemeOption[] = [
  ...designThemes.map((theme: DesignTheme): ThemeOption => ({
    value: theme.value,
    label: theme.label,
    preview: designTokens[theme.value]['color.surface.canvas'],
  })),
  {
    value: 'system',
    label: '시스템 설정 따르기',
    preview: `linear-gradient(90deg, ${designTokens.light['color.surface.canvas']} 50%, ${designTokens.dark['color.surface.canvas']} 50%)`,
  },
];

/** 화면 테마 선택만 표시하며 저장은 호출자가 맡습니다. */
export function ThemeSettings({
  preference,
  onChange,
}: ThemeSettingsProps): JSX.Element {
  const name = useId();
  return (
    <section className={styles.section} aria-labelledby={`${name}-title`}>
      <h2 id={`${name}-title`}>화면 테마</h2>
      <div className={styles.panel}>
        <fieldset className={styles.themeOptions}>
          <legend className={styles.visuallyHidden}>화면 테마 선택</legend>
          {options.map((option: ThemeOption): JSX.Element => (
            <label key={option.value} className={styles.themeOption}>
              <span
                className={styles.themePreview}
                style={{ background: option.preview }}
                aria-hidden="true"
              />
              <span className={styles.themeName}>
                <strong>{option.label}</strong>
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={preference === option.value}
                  onChange={(): void => onChange(option.value)}
                />
              </span>
            </label>
          ))}
        </fieldset>
        <p className={styles.note}>선택한 테마는 이 기기에 저장됩니다.</p>
      </div>
    </section>
  );
}
