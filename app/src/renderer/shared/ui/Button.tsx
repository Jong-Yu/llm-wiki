import type { JSX, ComponentPropsWithRef } from 'react';
import styles from './Button.module.scss';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary';
};

/** 표시와 네이티브 버튼 동작만 맡습니다. 폼 제출은 type="submit"으로 명시합니다. */
export function Button({
  children,
  type = 'button',
  variant = 'primary',
  className,
  ...props
}: ButtonProps): JSX.Element {
  const buttonClassName = [styles.button, styles[variant], className]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...props} type={type} className={buttonClassName}>
      {children}
    </button>
  );
}
