import type { JSX } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';

/** 기존 작업 주소는 문서 맥락으로 옮기며 숨겨진 화면은 탐색을 일으키지 않습니다. */
export function DocumentTasksPage(): JSX.Element | null {
  const location = useLocation();
  const active = useWorkspaceActivity();
  return active ? (
    <Navigate
      to={`/documents${location.search}`}
      state={location.state}
      replace
    />
  ) : null;
}
