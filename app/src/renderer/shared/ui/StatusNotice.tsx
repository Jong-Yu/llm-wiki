import type { JSX, ComponentPropsWithRef, ReactNode } from 'react';
import styles from './StatusNotice.module.scss';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export type StatusNoticeProps = Omit<ComponentPropsWithRef<'div'>, 'title'> & {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: ReactNode;
  action?: ReactNode;
  /** true면 동작 버튼을 본문 아래 한 줄로 내립니다. */
  stacked?: boolean;
  /** 테두리 상자는 제목 색으로 상태를 표시한다. 필요한 경우 아이콘을 함께 둔다. */
  showIcon?: boolean;
  /** bar(기본): 왼쪽 막대, box: 둥근 테두리 상자(채팅 시안). */
  variant?: 'bar' | 'box';
};

const toneIcons: Record<NonNullable<StatusNoticeProps['tone']>, IconName> = {
  info: 'info',
  success: 'circle-check',
  warning: 'triangle-alert',
  error: 'circle-alert',
};

/** 호출자가 결정한 상태와 동작을 표시하며 업무 성공/권한을 판단하지 않습니다. */
export function StatusNotice({
  tone = 'info',
  title,
  action,
  stacked,
  variant = 'bar',
  showIcon = variant === 'bar',
  children,
  className,
  role,
  ...props
}: StatusNoticeProps): JSX.Element {
  return (
    <div
      {...props}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={[
        styles.notice,
        styles[tone],
        stacked && styles.stacked,
        variant === 'box' && styles.box,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showIcon && (
        <Icon name={toneIcons[tone]} className={styles.icon} size={18} />
      )}
      <div className={styles.content}>
        {title != null && <strong className={styles.title}>{title}</strong>}
        {children != null && <div>{children}</div>}
      </div>
      {action != null && <div className={styles.action}>{action}</div>}
    </div>
  );
}
