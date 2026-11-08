import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import styles from './DocumentChips.module.scss';

type DocumentChipPopoverProps = {
  icon: IconName;
  label: string;
  popoverLabel: string;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
  children: (close: () => void) => ReactNode;
};

/** 칩을 눌러 여는 말풍선: 밖을 누르거나 Esc로 닫고 초점을 칩으로 돌려줍니다. */
export function DocumentChipPopover({
  icon,
  label,
  popoverLabel,
  disabled = false,
  active = false,
  accent = false,
  children,
}: DocumentChipPopoverProps): JSX.Element {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect((): (() => void) | undefined => {
    if (!open) return;
    /** 말풍선 밖의 누름은 초점을 옮기지 않고 닫기만 합니다. */
    const outside = (event: MouseEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return (): void => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const shown = open && !disabled;
  return (
    <div className={styles.popoverRoot} ref={root}>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className={styles.chip}
        data-active={active || shown}
        data-accent={accent && !disabled}
        disabled={disabled}
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        onClick={(): void => setOpen(!open)}
      >
        <Icon name={icon} size={14} />
        {label}
        <Icon name="chevron-down" size={14} className={styles.chevron} />
      </button>
      {shown && (
        <div
          id={id}
          className={styles.popover}
          role="group"
          aria-label={popoverLabel}
        >
          {children((): void => {
            setOpen(false);
            // 닫힌 뒤 초점을 칩으로 돌려줍니다(렌더 중 ref 접근을 피해 id로 찾음).
            document.getElementById(`${id}-trigger`)?.focus();
          })}
        </div>
      )}
    </div>
  );
}
