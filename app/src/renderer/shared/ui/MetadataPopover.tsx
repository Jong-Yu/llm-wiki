import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, JSX, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { useAnchoredOverlay } from './useAnchoredOverlay';
import styles from './MetadataPopover.module.scss';

export type MetadataPopoverProps = {
  icon?: IconName;
  label: string;
  popoverLabel: string;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
  control?: boolean;
  children: (close: () => void) => ReactNode;
};

/** 칩을 눌러 여는 말풍선: 밖을 누르거나 Esc로 닫고 초점을 칩으로 돌려줍니다. */
export function MetadataPopover({
  icon,
  label,
  popoverLabel,
  disabled = false,
  active = false,
  accent = false,
  control = false,
  children,
}: MetadataPopoverProps): JSX.Element {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const activePage = useWorkspaceActivity();
  const shown = open && !disabled && activePage;
  const panel = useAnchoredOverlay<HTMLDivElement>(
    trigger,
    shown,
    control ? 'end' : 'start',
  );
  useEffect((): (() => void) | undefined => {
    if (!shown) return;
    // portal의 DOM 위치와 무관하게 키보드로 바로 선택창 내용을 조작합니다.
    const firstInput =
      panel.current?.querySelector<HTMLElement>(
        'input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ??
      panel.current?.querySelector<HTMLElement>(
        'button:not(:disabled), a[href]',
      );
    (firstInput ?? panel.current)?.focus({ preventScroll: true });
    /** 말풍선 밖의 누름은 초점을 옮기지 않고 닫기만 합니다. */
    const outside = (event: MouseEvent): void => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
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
  }, [shown, panel]);
  return (
    <div className={styles.popoverRoot} ref={root}>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className={styles.chip}
        data-control={control}
        data-active={active || shown}
        data-accent={accent && !disabled}
        disabled={disabled}
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        onClick={(): void => setOpen(!open)}
      >
        {icon && <Icon name={icon} size={16} />}
        <span className={styles.label}>{label}</span>
        <Icon name="chevron-down" size={14} className={styles.chevron} />
      </button>
      {shown &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className={styles.popover}
            data-control={control}
            role="group"
            tabIndex={-1}
            aria-label={popoverLabel}
            onBlur={(event: FocusEvent<HTMLDivElement>): void => {
              if (
                event.relatedTarget instanceof Node &&
                !panel.current?.contains(event.relatedTarget) &&
                !root.current?.contains(event.relatedTarget)
              )
                setOpen(false);
            }}
          >
            {children((): void => {
              setOpen(false);
              // 닫힌 뒤 초점을 칩으로 돌려줍니다(렌더 중 ref 접근을 피해 id로 찾음).
              document.getElementById(`${id}-trigger`)?.focus();
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
