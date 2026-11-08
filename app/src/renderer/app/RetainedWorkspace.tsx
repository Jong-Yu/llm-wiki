import { useLayoutEffect, useRef, useState } from 'react';
import type { JSX, ReactNode, UIEvent } from 'react';
import { useLocation } from 'react-router';
import type { Location } from 'react-router';
import { WorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { workspacePageKey } from './workspaceNavigation';
import styles from './RetainedWorkspace.module.scss';

type RetainedLocation = { id: string; location: Location };
type RetainedWorkspaceState = {
  location: Location;
  pages: RetainedLocation[];
};
type RetainedWorkspaceProps = { render: (location: Location) => ReactNode };
type PageSlotProps = {
  active: boolean;
  id: string;
  children: ReactNode;
};

/** 각 화면의 스크롤과 입력은 실행 중 메모리에만 보관하며 숨긴 화면은 접근성 트리에서도 제외합니다. */
function PageSlot({ active, id, children }: PageSlotProps): JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const scroll = useRef({ left: 0, top: 0 });
  useLayoutEffect((): (() => void) | undefined => {
    if (!active) return;
    const node = element.current;
    if (node) {
      node.scrollLeft = scroll.current.left;
      node.scrollTop = scroll.current.top;
    }
    return undefined;
  }, [active]);
  return (
    <div
      ref={element}
      hidden={!active}
      className={styles.page}
      data-workspace-route={id}
      data-active={active ? 'true' : 'false'}
      onScroll={(event: UIEvent<HTMLDivElement>): void => {
        if (active)
          scroll.current = {
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
      }}
    >
      <WorkspaceActivity active={active}>{children}</WorkspaceActivity>
    </div>
  );
}

/** 방문한 화면만 만들고 비활성 화면의 주소를 고정하여 뒤로가기와 메뉴 이동 중 초안을 보존합니다. */
export function RetainedWorkspace({
  render,
}: RetainedWorkspaceProps): JSX.Element {
  const location = useLocation();
  const id = workspacePageKey(location.pathname, location.search);
  const [stored, setStored] = useState<RetainedWorkspaceState>(
    (): RetainedWorkspaceState => ({ location, pages: [{ id, location }] }),
  );
  // 새 주소를 같은 렌더에서 반영해 이전 대상의 순간 표시와 중복 마운트를 막습니다.
  if (stored.location !== location) {
    const pages = stored.pages.filter(
      (page: RetainedLocation): boolean => page.id !== 'not-found',
    );
    const found = pages.some(
      (page: RetainedLocation): boolean => page.id === id,
    );
    setStored({
      location,
      pages: found
        ? pages.map((page: RetainedLocation): RetainedLocation =>
            page.id === id ? { id, location } : page,
          )
        : [...pages, { id, location }],
    });
  }
  return (
    <>
      {stored.pages.map((page: RetainedLocation): JSX.Element => (
        <PageSlot key={page.id} id={page.id} active={page.id === id}>
          {render(page.location)}
        </PageSlot>
      ))}
    </>
  );
}
