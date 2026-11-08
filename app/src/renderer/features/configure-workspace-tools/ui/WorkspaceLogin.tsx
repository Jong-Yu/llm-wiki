import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import { BrandMark } from '@renderer/shared/ui/BrandMark';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useWorkspaceTools } from '../model/useWorkspaceTools';
import { ServerAccessForm } from './ServerAccessForm';
import styles from './WorkspaceTools.module.scss';

type WorkspaceLoginProps = { children: ReactNode; publicContent?: ReactNode };

/** 인증이 없는 동안 자료 화면을 내리고 로그인 또는 공개 가이드를 표시합니다. */
export function WorkspaceLogin({
  children,
  publicContent,
}: WorkspaceLoginProps): JSX.Element {
  const tools = useWorkspaceTools(false);
  if (tools.connection?.status === 'connected') {
    const connection = tools.connection;
    // 보관된 페이지와 초안을 다른 주체·관점·권한에서 재사용하지 않습니다.
    const scope = JSON.stringify([
      connection.connectionId,
      connection.serverUrl,
      connection.userId,
      connection.selection,
      connection.accessRevision ?? connection.policyRevision,
      connection.workspaces,
    ]);
    return (
      <ReadQueriesProvider key={scope} identity={scope}>
        {children}
      </ReadQueriesProvider>
    );
  }
  if (publicContent) return <>{publicContent}</>;
  const account = tools.connection?.rememberedAccount;
  return (
    <main className={`wiki-theme ${styles.loginPage}`} data-wiki-theme="light">
      <section
        className={`${styles.section} ${styles.login}`}
        aria-labelledby="account-title"
      >
        <h1 id="account-title" className={styles.loginBrand}>
          <BrandMark className={styles.loginMark} />
          LLM Wiki
        </h1>
        {tools.connectionError && (
          <StatusNotice tone="error" title={tools.connectionError.title}>
            {tools.connectionError.detail}
          </StatusNotice>
        )}
        {tools.connection?.warning && (
          <StatusNotice tone="warning" title="로그인 상태를 확인해 주세요">
            {tools.connection.warning}
          </StatusNotice>
        )}
        {tools.connection ? (
          <ServerAccessForm
            remembered
            name={account?.name ?? ''}
            serverUrl={account?.serverUrl ?? ''}
            busy={tools.connectionPending !== null}
            isConnecting={tools.connectionPending === 'connect'}
            onConnect={tools.connect}
            onModeChange={tools.clearConnectionError}
          />
        ) : (
          <p role={tools.connectionPending !== null ? 'status' : undefined}>
            {tools.connectionPending !== null
              ? '저장한 로그인 상태를 확인하고 있습니다…'
              : '로그인 상태를 불러오지 못했습니다.'}
          </p>
        )}
        {tools.connectionError && (
          <button
            type="button"
            className={styles.textButton}
            disabled={tools.connectionPending !== null}
            onClick={(): void => {
              void tools.refresh();
            }}
          >
            연결 다시 확인
          </button>
        )}
        <Link to="/guide" className={styles.textButton}>
          사용자 가이드
        </Link>
      </section>
    </main>
  );
}
