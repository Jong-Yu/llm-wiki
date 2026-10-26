import type { JSX, ReactNode } from 'react';
import { Button } from './Button';
import type { ButtonProps } from './Button';
import styles from './IconButton.module.scss';

export type IconButtonProps = Omit<ButtonProps, 'children' | 'aria-label'> & {
  'aria-label': string;
  children: ReactNode;
};

/** 접근 이름을 필수로 받고 아이콘 장식과 네이티브 버튼 동작을 분리합니다. */
export function IconButton({
  children,
  className,
  title,
  variant = 'secondary',
  'aria-label': label,
  ...props
}: IconButtonProps): JSX.Element {
  return (
    <Button
      {...props}
      variant={variant}
      aria-label={label}
      title={title ?? label}
      className={[styles.button, className].filter(Boolean).join(' ')}
    >
      <span className={styles.icon} aria-hidden="true">
        {children}
      </span>
    </Button>
  );
}
