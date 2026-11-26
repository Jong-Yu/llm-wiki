import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** 떠 있는 설명·선택창을 창 안에 배치하고 스크롤·확대에도 기준 버튼을 따라갑니다. */
export function useAnchoredOverlay<T extends HTMLElement>(
  anchor: RefObject<HTMLElement | null>,
  shown: boolean,
  align: 'start' | 'end' | 'center' = 'start',
): RefObject<T | null> {
  const overlay = useRef<T>(null);
  useLayoutEffect((): (() => void) | undefined => {
    if (!shown) return;
    const target = anchor.current;
    const panel = overlay.current;
    if (!target || !panel) return;
    /** 패널 자체만 크기를 제한하므로 문서에 불필요한 가로·세로 스크롤을 만들지 않습니다. */
    const place = (): void => {
      const gap = 8;
      const margin = 12;
      const bounds = target.getBoundingClientRect();
      panel.style.maxWidth = `${Math.max(0, innerWidth - margin * 2)}px`;
      panel.style.maxHeight = `${Math.max(0, innerHeight - margin * 2)}px`;
      const size = panel.getBoundingClientRect();
      const left =
        align === 'end'
          ? bounds.right - size.width
          : align === 'center'
            ? bounds.left + (bounds.width - size.width) / 2
            : bounds.left;
      const below = bounds.bottom + gap;
      const top =
        below + size.height <= innerHeight - margin
          ? below
          : bounds.top - gap - size.height;
      panel.style.left = `${Math.max(margin, Math.min(left, innerWidth - size.width - margin))}px`;
      panel.style.top = `${Math.max(margin, Math.min(top, innerHeight - size.height - margin))}px`;
      panel.style.visibility =
        bounds.width > 0 && bounds.bottom > 0 && bounds.top < innerHeight
          ? 'visible'
          : 'hidden';
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(target);
    observer.observe(panel);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return (): void => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [anchor, overlay, shown, align]);
  return overlay;
}
