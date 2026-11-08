import type { JSX } from 'react';
import {
  ThemeSettings,
  WorkspaceTools,
} from '@renderer/features/configure-workspace-tools';
import { AccountUsagePanel } from '@renderer/features/browse-ai-sessions';
import { useThemePreference } from '@renderer/shared/theme/useThemePreference';
import styles from './ConnectionSettingsPage.module.scss';

/** 공통 앱 프레임 안에서 실제 연결 설정 흐름을 표시하는 신규 페이지입니다. */
export function ConnectionSettingsPage(): JSX.Element {
  const { preference, setPreference } = useThemePreference();
  return (
    <div className={styles.page}>
      <WorkspaceTools
        accountUsage={<AccountUsagePanel />}
        appearance={
          <ThemeSettings preference={preference} onChange={setPreference} />
        }
      />
    </div>
  );
}
