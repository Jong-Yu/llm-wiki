import type { JSX } from 'react';
import { Link } from 'react-router';
import { DocumentTrashView } from '@renderer/features/browse-document-library';
import {
  importScopeKey,
  useImportScope,
} from '@renderer/features/import-document-content';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';

/** 현재 허용 범위를 확인한 후 문서 목록 조회와 독립적으로 휴지통을 엽니다. */
export function DocumentTrashPage(): JSX.Element {
  const model = useImportScope();
  if (model.state.status !== 'ready')
    return (
      <WorkspacePage title="휴지통">
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
    <DocumentTrashView
      key={importScopeKey(model.state.scope)}
      scope={model.state.scope}
    />
  );
}
