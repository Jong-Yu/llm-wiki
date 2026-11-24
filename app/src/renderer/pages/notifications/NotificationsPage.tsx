import type { JSX } from 'react';
import { Link } from 'react-router';
import {
  importScopeKey,
  useImportScope,
} from '@renderer/features/import-document-content';
import { NotificationList } from '@renderer/features/review-source-notifications';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';

/** 현재 계정·작업 공간을 확인한 후 그 범위의 서버 알림만 표시합니다. */
export function NotificationsPage(): JSX.Element {
  const model = useImportScope();
  if (model.state.status !== 'ready')
    return (
      <WorkspacePage title="알림">
        <p role={model.state.status === 'error' ? 'alert' : 'status'}>
          {model.state.status === 'error'
            ? model.state.message
            : model.state.status === 'loading'
              ? '작업 공간을 확인하고 있습니다…'
              : '작업 공간을 선택해 주세요.'}
        </p>
        <Link to="/settings">연결 설정</Link>
      </WorkspacePage>
    );
  return (
    <NotificationList
      key={importScopeKey(model.state.scope)}
      scope={model.state.scope}
    />
  );
}
