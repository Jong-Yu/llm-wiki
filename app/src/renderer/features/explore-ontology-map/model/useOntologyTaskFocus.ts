import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';

/** 새 작업은 제목으로, 보관한 초안은 마지막 입력으로 초점을 연결하며 숨긴 작업에는 진입하지 않습니다. */
export function useOntologyTaskFocus(
  open: boolean,
): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const active = useWorkspaceActivity();
  useLayoutEffect((): (() => void) => {
    const page = anchor.current?.closest('[data-workspace-page]');
    if (!open || !active || !(page instanceof HTMLElement))
      return (): void => {};
    const remember = (event: FocusEvent): void => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches('input, select, textarea, [role="tab"]')
      )
        previous.current = event.target;
    };
    page.addEventListener('focusin', remember);
    const frame = requestAnimationFrame((): void => {
      if (page.closest('[hidden], [inert]')) return;
      const previousInput = previous.current;
      if (
        previousInput?.isConnected &&
        !previousInput.closest('[hidden]') &&
        !previousInput.matches(':disabled')
      ) {
        previousInput.focus();
      } else {
        const heading = page.querySelector('h2');
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    });
    return (): void => {
      cancelAnimationFrame(frame);
      page.removeEventListener('focusin', remember);
    };
  }, [open, active]);
  return anchor;
}
