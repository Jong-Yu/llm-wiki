import type { JSX } from 'react';
import styles from './SessionActivity.module.scss';

type UsageBarProps = {
  remainingPercent: number;
  label: string;
  /** 헤더처럼 좁은 자리에서는 짧게 그립니다. */
  compact?: boolean;
};

/** 잔여 한도 막대. 20% 이하이면 주의색이며 채움이 항상 보이도록 직접 그립니다. */
export function UsageBar({
  remainingPercent,
  label,
  compact = false,
}: UsageBarProps): JSX.Element {
  const value = Math.min(100, Math.max(0, remainingPercent));
  return (
    <span
      className={styles.usageBar}
      data-compact={compact}
      data-low={value <= 20}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <i style={{ width: `${value}%` }} />
    </span>
  );
}
