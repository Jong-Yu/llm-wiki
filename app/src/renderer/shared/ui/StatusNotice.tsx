import type { JSX, ComponentPropsWithRef, ReactNode } from 'react';
import styles from './StatusNotice.module.scss';

export type StatusNoticeProps = Omit<ComponentPropsWithRef<'div'>, 'title'> & {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: ReactNode;
  action?: ReactNode;
};

/** 호출자가 결정한 상태와 동작을 표시하며 업무 성공/권한을 판단하지 않습니다. */
export function StatusNotice({
  tone = 'info',
  title,
  action,
  children,
  className,
  role,
  ...props
}: StatusNoticeProps): JSX.Element {
  return (
    <div
      {...props}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={[styles.notice, styles[tone], className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.content}>
        {title != null && <strong className={styles.title}>{title}</strong>}
        {children != null && <div>{children}</div>}
      </div>
      {action != null && <div className={styles.action}>{action}</div>}
    </div>
  );
}
