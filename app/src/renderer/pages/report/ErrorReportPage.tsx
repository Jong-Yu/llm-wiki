import type { JSX } from 'react';
import { Link } from 'react-router';
import {
  importScopeKey,
  useImportScope,
} from '@renderer/features/import-document-content';
import { ErrorReportForm } from '@renderer/features/report-error';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import styles from './ErrorReportPage.module.scss';

/** 현재 로그인 범위의 초안을 유지하고 오류 내용을 서버로 보고합니다. */
export function ErrorReportPage(): JSX.Element {
  const model = useImportScope();
  return (
    <WorkspacePage title="오류 보고" className={styles.page}>
      {model.state.status === 'ready' ? (
        <ErrorReportForm
          key={importScopeKey(model.state.scope)}
          connectionId={model.state.scope.connectionId}
        />
      ) : (
        <>
          <p role={model.state.status === 'error' ? 'alert' : 'status'}>
            {model.state.status === 'error'
              ? model.state.message
              : model.state.status === 'loading'
                ? '연결을 확인하고 있습니다…'
                : '작업 공간을 선택해 주세요.'}
          </p>
          {model.state.status !== 'loading' && (
            <Link to="/settings">연결 설정</Link>
          )}
        </>
      )}
    </WorkspacePage>
  );
}
