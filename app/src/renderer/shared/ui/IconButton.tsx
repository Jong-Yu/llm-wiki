import type { JSX } from 'react';
import { Button } from './Button';
import type { ButtonProps } from './Button';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { Tooltip } from './Tooltip';
import styles from './IconButton.module.scss';

export type IconButtonProps = Omit<ButtonProps, 'children' | 'aria-label'> & {
  icon: IconName;
  label: string;
  description?: string;
};

/** 익숙한 보조 행동을 같은 크기의 아이콘과 접근 가능한 이름·설명으로 제공합니다. */
export function IconButton({
  icon,
  label,
  description,
  size = 'small',
  variant = 'surface',
  className,
  ...props
}: IconButtonProps): JSX.Element {
  return (
    <Tooltip label={description ?? label}>
      {(descriptionId: string | undefined): JSX.Element => (
        <Button
          {...props}
          size={size}
          variant={variant}
          className={[styles.button, className].filter(Boolean).join(' ')}
          data-icon-size={size}
          aria-label={label}
          aria-describedby={descriptionId}
        >
          <Icon name={icon} />
        </Button>
      )}
    </Tooltip>
  );
}
