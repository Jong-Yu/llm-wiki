import type { JSX } from 'react';
import { Link } from 'react-router';
import { Button } from '@renderer/shared/ui/Button';
import { Panel, PanelBody, PanelHeader } from '@renderer/shared/ui/Panel';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useWorkspaceConnection } from '../model/useWorkspaceConnection';
import { ServerConnectionForm } from './ServerConnectionForm';
import { WorkspaceSelectionForm } from './WorkspaceSelectionForm';
import { ConnectionProtectionStatus } from './ConnectionProtectionStatus';
import styles from './ConnectWorkspace.module.scss';

const pendingMessages = {
  restoring: '연결 상태를 확인하고 있습니다',
  connecting: '서버를 확인하고 있습니다',
  selecting: '소속과 권한을 다시 확인하고 있습니다',
  disconnecting: '연결을 해제하고 있습니다',
  retrying: '저장한 연결의 현재 권한을 확인하고 있습니다',
  forgetting: '저장한 연결을 삭제하고 있습니다',
};

/** 서버의 공개 연결 상태와 두 폼의 배치를 조립합니다. */
export function ConnectWorkspace(): JSX.Element {
  const {
    snapshot,
    pending,
    error,
    connect,
    selectWorkspace,
    disconnect,
    restoreSaved,
    forgetSaved,
  } = useWorkspaceConnection();
  const connected = snapshot.status === 'connected' ? snapshot : null;
  const busy = pending !== null;

  return (
    <section className={styles.page} aria-labelledby="connection-title">
      <p className={styles.eyebrow}>WORKSPACE CONNECTION</p>
      <h1 id="connection-title">서버 연결·작업 공간 선택</h1>
      <p className={styles.introduction}>
        자료 서버에서 내 소속을 확인한 뒤 사용할 작업 공간과 관점을 선택합니다.
      </p>
      {error && (
        <StatusNotice tone="error" title="연결을 확인하지 못했습니다">
          <p className={styles.message}>{error.message}</p>
          {error.traceId && <small>문의 코드: {error.traceId}</small>}
        </StatusNotice>
      )}
      {pending && (
        <StatusNotice
          title={pendingMessages[pending]}
          action={
            pending === 'connecting' || pending === 'selecting' ? (
              <Button
                variant="secondary"
                onClick={(): void => void disconnect()}
              >
                연결 취소
              </Button>
            ) : undefined
          }
        >
          확인이 끝날 때까지 잠시 기다려 주세요.
        </StatusNotice>
      )}
      <div className={styles.columns}>
        <Panel aria-labelledby="server-title">
          <PanelHeader>
            <div>
              <p className={styles.step}>01 · 자료 서버</p>
              <h2 id="server-title">연결 정보</h2>
            </div>
          </PanelHeader>
          <PanelBody>
            {/* 새 연결은 이전 입력 초안을 버리고 확인된 주소로 다시 시작합니다. */}
            <ServerConnectionForm
              key={connected ? connected.connectionId : 'disconnected'}
              initialServerUrl={connected ? connected.serverUrl : ''}
              initiallyRemembered={snapshot.protection?.remembered ?? false}
              busy={busy}
              onConnect={connect}
            />
            <ConnectionProtectionStatus
              protection={snapshot.protection}
              busy={busy}
              onRestore={restoreSaved}
              onForget={forgetSaved}
            />
            {connected && (
              <div className={styles.current}>
                <h3>현재 연결된 서버</h3>
                <dl>
                  <dt>주소</dt>
                  <dd>{connected.serverUrl}</dd>
                  <dt>사용자</dt>
                  <dd>{connected.userId}</dd>
                  <dt>마지막 확인</dt>
                  <dd>
                    <time dateTime={connected.checkedAt}>
                      {new Date(connected.checkedAt).toLocaleString('ko-KR')}
                    </time>
                  </dd>
                </dl>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={(): void => void disconnect()}
                >
                  연결 해제
                </Button>
                <p className={styles.note}>
                  연결을 해제하면 이 PC에 저장한 인증정보도 삭제합니다. 서버의
                  토큰 회수와 자료 삭제는 수행하지 않습니다.
                </p>
              </div>
            )}
          </PanelBody>
        </Panel>
        <Panel aria-labelledby="workspace-title">
          <PanelHeader>
            <div>
              <p className={styles.step}>02 · 사용 범위</p>
              <h2 id="workspace-title">작업 공간</h2>
            </div>
          </PanelHeader>
          <PanelBody>
            {connected ? (
              // 서버의 허용 범위가 바뀌면 이전 선택 초안을 다시 사용하지 않습니다.
              <WorkspaceSelectionForm
                key={`${connected.connectionId}:${connected.policyRevision}`}
                connection={connected}
                busy={busy}
                onSelect={selectWorkspace}
              />
            ) : (
              <div className={styles.empty}>
                <h3>자료 서버에 먼저 연결해 주세요</h3>
                <p>확인된 소속과 허용된 관점만 여기에 표시됩니다.</p>
              </div>
            )}
            {connected?.selection && (
              <div className={styles.selection}>
                <StatusNotice tone="success" title="작업 공간이 선택되었습니다">
                  작업 공간 <strong>{connected.selection.tenant}</strong> · 관점{' '}
                  <strong>{connected.selection.profile}</strong>
                  <p>
                    <Link className="text-link" to="/documents">
                      문서 목록 보기 →
                    </Link>
                  </p>
                </StatusNotice>
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>
      <p className={styles.note}>
        개인 AI·MCP 연결은 별도입니다. 이 화면에서는 자료 서버의 인증·소속·허용
        범위만 확인합니다.
      </p>
    </section>
  );
}
