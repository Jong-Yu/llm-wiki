import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';
import { designTokens } from '../theme/tokens';
import { Button } from './Button';
import styles from './WorkspaceLayout.module.scss';

type Pane = 'index' | 'content' | 'inspector';
type Density = 'wide' | 'compact' | 'single';
type LayoutState = {
  id: string;
  density: Density;
  active: Pane;
  indexOpen: boolean;
};
type WorkspaceLayoutProps = {
  children: ReactNode;
  className?: string;
  labels?: Partial<Record<Pane, string>>;
  panes?: readonly Pane[];
};
type WorkspacePaneProps = { name: Pane; children: ReactNode };
type WorkspaceToolbarProps = ComponentPropsWithRef<'header'>;
const LayoutContext = createContext<LayoutState | null>(null);
const defaultPanes: readonly Pane[] = ['index', 'content', 'inspector'];
const defaultLabels: Record<Pane, string> = {
  index: '목록',
  content: '본문',
  inspector: '정보',
};

/** 모니터 해상도 대신 실제 작업 영역의 너비로 패널 배치를 결정합니다. */
function densityFor(width: number): Density {
  if (width < designTokens.light['layout.responsive.singleWidth'])
    return 'single';
  return width < designTokens.light['layout.responsive.compactWidth']
    ? 'compact'
    : 'wide';
}

/** 숨길 패널의 편집 상태를 유지하며 좁은 창에서도 모든 패널로 이동할 수 있게 합니다. */
export function WorkspaceLayout({
  children,
  className,
  labels,
  panes = defaultPanes,
}: WorkspaceLayoutProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const id = useId();
  const [density, setDensity] = useState<Density>('wide');
  const [active, setActive] = useState<Pane>('content');
  const [indexOpen, setIndexOpen] = useState(true);

  useEffect((): (() => void) | undefined => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(
      (entries: ResizeObserverEntry[]): void => {
        const width = entries[0]?.contentRect.width;
        if (width === undefined) return;
        const next = densityFor(width);
        // 크기 변경으로 포커스가 있는 폼을 숨기지 않습니다.
        if (
          next !== 'wide' &&
          document.activeElement instanceof HTMLElement &&
          element.contains(document.activeElement)
        ) {
          const focusedPane = document.activeElement
            .closest('[data-workspace-pane]')
            ?.getAttribute('data-workspace-pane');
          if (focusedPane === 'index' && next === 'compact') setIndexOpen(true);
          if (
            focusedPane === 'content' ||
            focusedPane === 'inspector' ||
            (focusedPane === 'index' && next === 'single')
          )
            setActive(focusedPane);
        }
        if (
          next === 'wide' &&
          controls.current?.contains(document.activeElement)
        )
          element.focus({ preventScroll: true });
        setDensity(next);
      },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);

  /** 목록의 접힘과 단일 패널 전환은 자료 선택·저장 상태와 분리합니다. */
  function selectPane(pane: Pane): void {
    if (pane === 'index' && density === 'compact')
      setIndexOpen((value: boolean): boolean => !value);
    else setActive(pane);
  }
  const visibleActive =
    !panes.includes(active) || (density === 'compact' && active === 'index')
      ? 'content'
      : active;
  const state: LayoutState = { id, density, active: visibleActive, indexOpen };
  return (
    <LayoutContext value={state}>
      <div
        ref={root}
        className={styles.workspace}
        data-layout-density={density}
        tabIndex={-1}
      >
        <div
          ref={controls}
          className={styles.controls}
          role="group"
          aria-label="작업 영역 패널"
          hidden={density === 'wide'}
        >
          {panes.map((pane: Pane): JSX.Element => {
            const selected =
              pane === 'index' && density === 'compact'
                ? indexOpen
                : visibleActive === pane;
            return (
              <Button
                key={pane}
                variant="secondary"
                aria-controls={`${id}-${pane}`}
                data-workspace-target={pane}
                aria-pressed={selected}
                onClick={(): void => selectPane(pane)}
              >
                {labels?.[pane] ?? defaultLabels[pane]}
              </Button>
            );
          })}
        </div>
        <div
          className={[styles.panels, className].filter(Boolean).join(' ')}
          data-index-open={indexOpen}
        >
          {children}
        </div>
      </div>
    </LayoutContext>
  );
}

/** 패널을 재마운트하지 않고 표시와 키보드 접근을 함께 전환합니다. */
export function WorkspacePane({
  name,
  children,
}: WorkspacePaneProps): JSX.Element {
  const state = useContext(LayoutContext);
  if (!state)
    throw new Error('WorkspacePane은 WorkspaceLayout 안에서 사용합니다.');
  const hidden =
    state.density === 'single'
      ? state.active !== name
      : state.density === 'compact'
        ? name === 'index'
          ? !state.indexOpen
          : name !== (state.active === 'inspector' ? 'inspector' : 'content')
        : false;
  return (
    <div
      id={`${state.id}-${name}`}
      className={styles.pane}
      data-workspace-pane={name}
      hidden={hidden}
    >
      {children}
    </div>
  );
}

/** 고정 높이 도구 모음의 동작이 잘리지 않도록 영역 안에서 가로로 이동합니다. */
export function WorkspaceToolbar({
  className,
  ...props
}: WorkspaceToolbarProps): JSX.Element {
  return (
    <header
      {...props}
      className={[styles.toolbar, className].filter(Boolean).join(' ')}
    />
  );
}
