import { createContext, useContext } from 'react';
import type { JSX, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceActivity } from './workspaceActivity';

// undefined: 앱 Header가 없는 곳(단독 표시)이라 버튼을 제자리에 그립니다. null: Header 자리가 아직 준비 중입니다.
const HeaderActionsContext = createContext<HTMLElement | null | undefined>(
  undefined,
);
type HeaderActionsProviderProps = {
  node: HTMLElement | null;
  children: ReactNode;
};
type HeaderActionsProps = { children: ReactNode };

/** 앱 Header의 오른쪽 버튼 자리를 화면들에 전달합니다. */
export function HeaderActionsProvider({
  node,
  children,
}: HeaderActionsProviderProps): JSX.Element {
  return <HeaderActionsContext value={node}>{children}</HeaderActionsContext>;
}

/**
 * 화면의 주 행동(최대 3개)을 Header 오른쪽에 놓습니다.
 * 보관만 되고 보이지 않는 화면의 버튼이 Header에 남지 않도록 활성 화면에서만 그립니다.
 */
export function HeaderActions({
  children,
}: HeaderActionsProps): JSX.Element | null {
  const node = useContext(HeaderActionsContext);
  const active = useWorkspaceActivity();
  if (node === undefined) return <>{children}</>;
  return node && active ? createPortal(children, node) : null;
}
