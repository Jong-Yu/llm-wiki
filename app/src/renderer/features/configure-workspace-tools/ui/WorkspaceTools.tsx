import { Button } from '@renderer/shared/ui/Button';
import { useLocation, useSearchParams } from 'react-router';
import type { WorkspaceMembership } from '@contracts/connection.contract';
import { Tabs } from '@renderer/shared/ui/Tabs';
import type { JSX, ReactNode } from 'react';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useWorkspaceTools } from '../model/useWorkspaceTools';
import { describeToolsProtection } from '../model/workspaceToolsState';
import { ServerAccessForm } from './ServerAccessForm';
import { WorkspaceAccessForm } from './WorkspaceAccessForm';
import { PersonalAiSettings } from './PersonalAiSettings';
import styles from './WorkspaceTools.module.scss';

/** 서버 계정과 개인 AI의 연결 설정을 조립합니다. */
type WorkspaceToolsProps = {
  accountUsage?: ReactNode;
  /** 화면(테마) 탭 내용입니다. 없으면 탭을 표시하지 않습니다. */
  appearance?: ReactNode;
};

export function WorkspaceTools({
  accountUsage,
  appearance,
}: WorkspaceToolsProps): JSX.Element {
  const tools = useWorkspaceTools();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const section = search.get('section');
  const tab =
    section === 'ai'
      ? 'ai'
      : section === 'appearance'
        ? 'appearance'
        : 'account';
  const setTab = (value: string): void => {
    const next = new URLSearchParams(search);
    next.set(
      'section',
      value === 'ai' || value === 'appearance' ? value : 'connection',
    );
    setSearch(next);
  };
  const connected =
    tools.connection?.status === 'connected' ? tools.connection : null;
  const protection = tools.connection?.protection;
  const protectionNotice = describeToolsProtection(protection);
  const busy = tools.connectionPending !== null;
  const accountForm = tools.connection ? (
    <ServerAccessForm
      key={connected?.connectionId ?? 'disconnected'}
      serverUrl={
        connected?.serverUrl ??
        tools.connection.rememberedAccount?.serverUrl ??
        ''
      }
      name={
        connected?.displayName ?? tools.connection.rememberedAccount?.name ?? ''
      }
      busy={busy}
      isConnecting={tools.connectionPending === 'connect'}
      onConnect={tools.connect}
      onModeChange={tools.clearConnectionError}
    />
  ) : (
    <p className={styles.note}>
      {busy
        ? '현재 연결을 읽고 있습니다…'
        : '현재 연결 상태를 확인하지 못했습니다.'}
    </p>
  );

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Tabs
          label="설정 구분"
          value={tab}
          onValueChange={setTab}
          items={[
            {
              id: 'account',
              label: '서버·계정',
              content: (
                <section
                  className={styles.section}
                  aria-labelledby="workspace-server-title"
                  aria-busy={busy}
                >
                  <h2
                    id="workspace-server-title"
                    className={styles.visuallyHidden}
                  >
                    서버·계정
                  </h2>
                  {connected ? (
                    <div className={styles.card}>
                      <span className={styles.avatar} aria-hidden="true">
                        {Array.from(connected.displayName ?? '사')[0]}
                      </span>
                      <div>
                        <strong>
                          {connected.displayName ?? '로그인한 사용자'}
                        </strong>
                        <div className={styles.note}>
                          {connected.serverUrl.replace(/api\/v1\/$/, '')}
                        </div>
                      </div>
                      <div className={styles.cardActions}>
                        <span className={styles.goodBadge}>
                          {busy ? '확인 중' : '연결됨'}
                        </span>
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={busy}
                          onClick={(): void => {
                            void tools.refresh();
                          }}
                        >
                          연결 확인
                        </button>
                        <Button
                          variant="surface"
                          type="button"
                          className={styles.button}
                          disabled={busy}
                          onClick={(): void => {
                            void tools.disconnect();
                          }}
                        >
                          로그아웃
                        </Button>
                      </div>
                      <div className={styles.cardFooter}>
                        <p className={styles.note}>
                          현재 작업 공간{' '}
                          <strong>
                            {connected.workspaces.find(
                              (item: WorkspaceMembership): boolean =>
                                item.id === connected.selection?.tenant,
                            )?.displayName ?? '선택 안 함'}
                          </strong>
                        </p>
                        {/* 전환은 사이드바가 맡고, 아직 고르지 않았을 때만 여기서 고릅니다. */}
                        {!connected.selection?.tenant && (
                          <WorkspaceAccessForm
                            key={`${connected.connectionId}:${connected.policyRevision}`}
                            connection={connected}
                            busy={busy}
                            onSelect={tools.select}
                          />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className={styles.connectionSummary}>
                      <div className={styles.connectionState}>
                        <span>연결 상태</span>
                        <span
                          className={
                            connected ? styles.goodBadge : styles.badge
                          }
                        >
                          {busy ? '확인 중' : connected ? '연결됨' : '연결 전'}
                        </span>
                      </div>
                      <div className={styles.utilityActions}>
                        <button
                          type="button"
                          className={styles.textButton}
                          disabled={busy}
                          onClick={(): void => {
                            void tools.refresh();
                          }}
                        >
                          연결 다시 확인
                        </button>
                        {protection?.saved && (
                          <button
                            type="button"
                            className={styles.textButton}
                            disabled={busy}
                            onClick={(): void => {
                              void tools.restore();
                            }}
                          >
                            저장한 연결 복원
                          </button>
                        )}
                        {(connected || protection?.saved) && (
                          <button
                            type="button"
                            className={styles.textButton}
                            disabled={busy}
                            onClick={(): void => {
                              void tools.disconnect();
                            }}
                          >
                            로그아웃
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {tools.connectionError && (
                    <StatusNotice
                      tone="error"
                      title={tools.connectionError.title}
                    >
                      {tools.connectionError.detail}
                    </StatusNotice>
                  )}
                  {tools.connection?.warning && (
                    <StatusNotice tone="warning" title="연결 처리 안내">
                      {tools.connection.warning}
                    </StatusNotice>
                  )}
                  {protectionNotice && (
                    <StatusNotice tone="warning" title={protectionNotice.title}>
                      {protectionNotice.detail}
                    </StatusNotice>
                  )}
                  {/* 다른 서버·계정은 로그아웃한 뒤 다시 로그인합니다. */}
                  {!connected && accountForm}
                </section>
              ),
            },
            {
              id: 'ai',
              label: (
                <>
                  AI 실행{' '}
                  {tools.runtime?.restartRequired ? '· 재시작 필요' : ''}
                </>
              ),
              content: (
                <PersonalAiSettings
                  state={tools.runtime}
                  pending={tools.runtimePending}
                  error={tools.runtimeError}
                  onRequest={tools.runRuntime}
                  accountUsage={accountUsage}
                  usageLinkKey={
                    tab === 'ai' && location.hash === '#account-usage'
                      ? location.key
                      : null
                  }
                />
              ),
            },
            ...(appearance
              ? [{ id: 'appearance', label: '화면', content: appearance }]
              : []),
          ]}
        />
      </div>
    </div>
  );
}
