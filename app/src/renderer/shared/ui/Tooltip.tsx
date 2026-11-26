import { useEffect, useId, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { useAnchoredOverlay } from './useAnchoredOverlay';
import styles from './Tooltip.module.scss';

type TooltipProps = {
  label: string;
  className?: string;
  children: (descriptionId: string | undefined) => JSX.Element;
};

/** 이름·아이콘의 설명을 hover와 focus에서 열고 화면 경계 안에서 유지합니다. */
export function Tooltip({
  label,
  className,
  children,
}: TooltipProps): JSX.Element {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const hovering = useRef(false);
  const focused = useRef(false);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const active = useWorkspaceActivity();
  const shown = open && active;
  /** 버튼과 설명 사이를 옮길 때도 설명을 읽을 수 있게 닫기를 잠시 미룹니다. */
  function reveal(): void {
    if (timer.current !== null) window.clearTimeout(timer.current);
    document.dispatchEvent(
      new CustomEvent('wiki-tooltip-open', { detail: id }),
    );
    setOpen(true);
  }
  /** 120ms 동안 버튼·설명 사이 이동을 허용하고 키보드 초점도 유지합니다. */
  function conceal(): void {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout((): void => {
      if (!hovering.current && !focused.current) setOpen(false);
    }, 120);
  }
  useEffect((): (() => void) => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    /** 키보드 초점이 다른 설명으로 옮겨가면 멈춰 있는 마우스의 설명은 닫습니다. */
    const supersede = (event: Event): void => {
      if (event instanceof CustomEvent && event.detail !== id) setOpen(false);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('wiki-tooltip-open', supersede);
    return (): void => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('wiki-tooltip-open', supersede);
    };
  }, [id]);
  const tooltip = useAnchoredOverlay<HTMLSpanElement>(anchor, shown, 'center');
  return (
    <span
      ref={anchor}
      className={[styles.anchor, className].filter(Boolean).join(' ')}
      onMouseEnter={(): void => {
        hovering.current = true;
        reveal();
      }}
      onMouseLeave={(): void => {
        hovering.current = false;
        conceal();
      }}
      onFocus={(): void => {
        focused.current = true;
        reveal();
      }}
      onBlur={(): void => {
        focused.current = false;
        conceal();
      }}
    >
      {children(shown ? id : undefined)}
      {shown &&
        createPortal(
          <span
            ref={tooltip}
            id={id}
            role="tooltip"
            className={styles.tooltip}
            onMouseEnter={(): void => {
              hovering.current = true;
              reveal();
            }}
            onMouseLeave={(): void => {
              hovering.current = false;
              conceal();
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
