import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { designTokens } from '@renderer/shared/theme/tokens';
import { Icon } from './Icon';
import styles from './ReadingProperties.module.scss';

type ReadingPropertiesProps = {
  title?: string;
  children: ReactNode;
  className?: string;
};

/** 읽기 속성은 좁은 작업 공간에서 접되 사용자 선택과 안쪽 초점을 보존합니다. */
export function ReadingProperties({
  title = '문서 정보',
  children,
  className,
}: ReadingPropertiesProps): JSX.Element {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const restoreHeadingFocus = useRef(false);
  const [narrow, setNarrow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect((): (() => void) | undefined => {
    const element = root.current;
    const workspace =
      element?.closest('[data-workspace-container]') ?? element?.parentElement;
    if (!workspace) return;
    /** 외곽 페이지 gutter를 빼기 전 작업 공간의 폭을 사용합니다. */
    const measure = (): void => {
      const next =
        workspace.getBoundingClientRect().width <
        designTokens.light['layout.responsive.singleWidth'];
      if (next && body.current?.contains(document.activeElement))
        setExpanded(true);
      if (!next && document.activeElement === toggle.current)
        restoreHeadingFocus.current = true;
      setNarrow(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return (): void => observer.disconnect();
  }, []);

  useLayoutEffect((): void => {
    if (!narrow && restoreHeadingFocus.current) {
      restoreHeadingFocus.current = false;
      root.current?.focus({ preventScroll: true });
    }
  }, [narrow]);

  return (
    <aside
      ref={root}
      className={[styles.root, className].filter(Boolean).join(' ')}
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
    >
      {narrow ? (
        <h2 id={`${id}-title`} className={styles.heading}>
          <button
            ref={toggle}
            type="button"
            aria-expanded={expanded}
            aria-controls={`${id}-body`}
            onClick={(): void => setExpanded(!expanded)}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            {title}
          </button>
        </h2>
      ) : (
        <h2 id={`${id}-title`} className={styles.heading}>
          {title}
        </h2>
      )}
      <div
        ref={body}
        id={`${id}-body`}
        className={styles.body}
        hidden={narrow && !expanded}
      >
        {children}
      </div>
    </aside>
  );
}
