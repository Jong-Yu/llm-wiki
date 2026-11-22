import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, ToggleEvent } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './AiSessions.module.scss';

type SessionActionsProps = { title: string; onDismiss: () => void };

/** 목록 정리는 더보기 안에 두며, 팝오버의 바깥 클릭·Escape는 브라우저가 처리합니다. */
export function SessionActions({
  title,
  onDismiss,
}: SessionActionsProps): JSX.Element {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect((): (() => void) | undefined => {
    if (!open) return;
    /** 행이 움직이면 해당 위치에 남은 메뉴를 닫습니다. */
    const close = (): void => popup.current?.hidePopover();
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return (): void => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);

  /** 스크롤 영역에 잘리지 않는 최상위 표시층을 버튼의 오른쪽 끝에 맞춥니다. */
  function toggle(event: ToggleEvent<HTMLDivElement>): void {
    const shown = event.newState === 'open';
    setOpen(shown);
    const button = trigger.current;
    const panel = popup.current;
    if (!shown || !button || !panel) return;
    const anchor = button.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const page = button.closest('[data-session-page]')?.getBoundingClientRect();
    const edge = 8;
    const rightLimit = window.innerWidth - edge - bounds.width;
    const leftLimit = Math.min(
      Math.max(edge, (page?.left ?? 0) + edge),
      rightLimit,
    );
    const top =
      anchor.bottom + 4 + bounds.height <= window.innerHeight - edge
        ? anchor.bottom + 4
        : anchor.top - 4 - bounds.height;
    panel.style.top = `${Math.max(edge, top)}px`;
    panel.style.left = `${Math.max(leftLimit, Math.min(anchor.right - bounds.width, rightLimit))}px`;
    panel.querySelector('button')?.focus({ preventScroll: true });
  }

  /** 확인한 행이 없어져도 다음 행이나 목록 영역에서 키보드 탐색을 이어갑니다. */
  function dismiss(): void {
    const row = trigger.current?.closest('li');
    const next =
      row?.nextElementSibling?.querySelector<HTMLElement>(
        '[data-session-actions]',
      ) ??
      row?.previousElementSibling?.querySelector<HTMLElement>(
        '[data-session-actions]',
      ) ??
      trigger.current?.closest<HTMLElement>('[data-session-page]');
    popup.current?.hidePopover();
    onDismiss();
    next?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.moreAction}
        data-session-actions
        popoverTarget={id}
        aria-expanded={open}
        aria-label={`더보기 · ${title}`}
        title="더보기"
      >
        <Icon name="ellipsis" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        className={styles.sessionPopover}
        role="group"
        aria-label={`세션 관리 · ${title}`}
        onToggle={toggle}
      >
        <button type="button" className={styles.dismissItem} onClick={dismiss}>
          목록에서 지우기
        </button>
        <p className={styles.dismissNote}>저장된 기록은 남아요.</p>
      </div>
    </>
  );
}
