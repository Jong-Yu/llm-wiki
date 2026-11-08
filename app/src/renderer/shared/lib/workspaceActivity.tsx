import { createContext, useContext } from 'react';
import type { JSX, ReactNode } from 'react';

const WorkspaceActivityContext = createContext(true);
type WorkspaceActivityProps = { active: boolean; children: ReactNode };

/** 보관된 화면의 실행은 유지하되 완료 응답이 현재 탐색을 가로채지 않도록 표시 상태를 전달합니다. */
export function WorkspaceActivity({
  active,
  children,
}: WorkspaceActivityProps): JSX.Element {
  return (
    <WorkspaceActivityContext value={active}>
      {children}
    </WorkspaceActivityContext>
  );
}

/** 비활성 화면에서는 자동 포커스·주소 변경을 생략할 수 있습니다. */
export function useWorkspaceActivity(): boolean {
  return useContext(WorkspaceActivityContext);
}
