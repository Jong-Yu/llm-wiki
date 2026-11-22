import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import { useId, useState } from 'react';
import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
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
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState<'refresh' | 'logout' | null>(
    null,
  );
  const waiting =
    tools.connection?.status === 'connected' &&
    tools.connection.workspaces.length === 0;
  if (tools.connection?.status === 'connected' && !waiting) {
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
        {waiting ? (
          <section
            className={styles.assignmentWaiting}
            aria-labelledby="assignment-title"
          >
            <h2 id="assignment-title">워크스페이스 배정 대기</h2>
            <p>
              로그인했습니다. 관리자가 워크스페이스를 배정하면 사용할 수
              있습니다.
            </p>
            <div className={styles.assignmentActions}>
              <span
                className={styles.assignmentRefresh}
                onMouseEnter={(): void => setTooltipOpen('refresh')}
                onMouseLeave={(): void => setTooltipOpen(null)}
              >
                <Button
                  variant="surface"
                  size="small"
                  aria-label="워크스페이스 배정 다시 확인"
                  aria-describedby={
                    tooltipOpen === 'refresh' ? tooltipId : undefined
                  }
                  disabled={tools.connectionPending !== null}
                  onFocus={(): void => setTooltipOpen('refresh')}
                  onBlur={(): void => setTooltipOpen(null)}
                  onKeyDown={(
                    event: KeyboardEvent<HTMLButtonElement>,
                  ): void => {
                    if (event.key === 'Escape') {
                      setTooltipOpen(null);
                      event.preventDefault();
                    }
                  }}
                  onClick={(): void => {
                    setTooltipOpen(null);
                    void tools.refresh();
                  }}
                >
                  <Icon name="refresh-cw" />
                </Button>
                {tooltipOpen === 'refresh' && (
                  <span
                    id={tooltipId}
                    role="tooltip"
                    className={styles.assignmentTooltip}
                  >
                    배정 다시 확인
                  </span>
                )}
              </span>
              <span
                className={styles.assignmentRefresh}
                onMouseEnter={(): void => setTooltipOpen('logout')}
                onMouseLeave={(): void => setTooltipOpen(null)}
              >
                <Button
                  variant="surface"
                  size="small"
                  aria-label="로그아웃"
                  aria-describedby={
                    tooltipOpen === 'logout' ? `${tooltipId}-logout` : undefined
                  }
                  disabled={tools.connectionPending === 'disconnect'}
                  onFocus={(): void => setTooltipOpen('logout')}
                  onBlur={(): void => setTooltipOpen(null)}
                  onKeyDown={(
                    event: KeyboardEvent<HTMLButtonElement>,
                  ): void => {
                    if (event.key === 'Escape') {
                      setTooltipOpen(null);
                      event.preventDefault();
                    }
                  }}
                  onClick={(): void => {
                    setTooltipOpen(null);
                    void tools.disconnect();
                  }}
                >
                  <Icon name="log-out" />
                </Button>
                {tooltipOpen === 'logout' && (
                  <span
                    id={`${tooltipId}-logout`}
                    role="tooltip"
                    className={styles.assignmentTooltip}
                  >
                    로그아웃
                  </span>
                )}
              </span>
              {tools.connectionPending === 'refresh' && (
                <span role="status">배정 확인 중…</span>
              )}
            </div>
          </section>
        ) : tools.connection ? (
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
        {tools.connectionError && !waiting && (
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
