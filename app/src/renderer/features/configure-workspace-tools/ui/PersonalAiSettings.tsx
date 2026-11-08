import { Button } from '@renderer/shared/ui/Button';
import { useEffect, useId, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import type {
  AiProvider,
  RuntimeCheck,
  RuntimeRequest,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import { levelFromSnapshot } from '@renderer/shared/lib/useAiConnection';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { AiStatusCard } from './AiStatusCard';
import { RuntimeDiagnostics } from './RuntimeDiagnostics';
import type { ToolsFailure } from '../model/workspaceToolsState';
import styles from './WorkspaceTools.module.scss';

type PersonalAiSettingsProps = {
  state: RuntimeSnapshot | null;
  pending: RuntimeRequest['operation'] | null;
  error: ToolsFailure | null;
  onRequest: (request: RuntimeRequest) => Promise<void>;
  accountUsage?: ReactNode;
  usageLinkKey: string | null;
};
const providers: Record<AiProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** AI 선택·연결 상태와 사용자가 명시적으로 연 진단/사용량만 표시합니다. */
export function PersonalAiSettings({
  state,
  pending,
  error,
  onRequest,
  accountUsage,
  usageLinkKey,
}: PersonalAiSettingsProps): JSX.Element {
  const titleId = useId();
  const advancedId = useId();
  const paths = useRef<HTMLDetailsElement>(null);
  const pathButton = useRef<HTMLButtonElement>(null);
  const usageFold = useRef<HTMLDetailsElement>(null);
  const pathTrigger = useRef<HTMLElement | null>(null);
  const selected = state?.settings.provider;
  const level =
    pending === 'connect-cli' ||
    pending === 'check-cli-login' ||
    pending === 'test-ai' ||
    pending === 'select-provider'
      ? 'checking'
      : state
        ? levelFromSnapshot(state)
        : 'unknown';
  const busy = pending !== null || level === 'checking';
  const connection = state?.cliConnection;
  const connected = level === 'verified' || level === 'login';
  const showUsage =
    Boolean(accountUsage) &&
    (level === 'verified' || (level === 'login' && usageLinkKey !== null));
  const pathsNeeded = Boolean(
    state && (!state.settings.root || !state.settings.python),
  );
  const needsDiagnostics =
    pathsNeeded ||
    error ||
    state?.issue ||
    state?.restartRequired ||
    state?.checks.some(
      (check: RuntimeCheck): boolean =>
        !check.optional &&
        (check.status === 'missing' || check.status === 'error'),
    );
  const hideClosedPaths =
    level === 'error' || (level === 'required' && !needsDiagnostics);

  useEffect((): void => {
    if (usageLinkKey !== null && showUsage && usageFold.current) {
      usageFold.current.open = true;
      usageFold.current.querySelector('summary')?.focus();
    }
  }, [usageLinkKey, showUsage]);

  /** 파일 선택 창은 별도 명시 동작으로 열고, 현재 제공자의 경로 버튼까지 포커스를 옮깁니다. */
  function openPaths(): void {
    if (!paths.current) return;
    pathTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    paths.current.open = true;
    pathButton.current?.focus();
  }

  return (
    <section className={styles.aiSettings} aria-labelledby={titleId}>
      <h2 id={titleId}>사용할 AI</h2>
      {error && (
        <StatusNotice tone="error" title={error.title}>
          {error.detail}
        </StatusNotice>
      )}
      {state?.issue && (
        <StatusNotice tone="warning" title="저장된 설정을 확인해 주세요">
          {state.issue}
        </StatusNotice>
      )}
      {!state && (
        <div className={styles.utilityActions}>
          <p className={styles.note} role="status">
            {busy
              ? '연결 정보를 읽고 있습니다…'
              : '연결 정보를 읽지 못했습니다.'}
          </p>
          <Button
            variant="surface"
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={(): void => {
              void onRequest({ operation: 'read' });
            }}
          >
            다시 읽기
          </Button>
        </div>
      )}
      <div
        className={styles.providers}
        role="group"
        aria-label="연결할 AI 선택"
      >
        {(['claude', 'codex'] as const).map(
          (provider: AiProvider): JSX.Element => (
            <button
              key={provider}
              type="button"
              className={styles.provider}
              aria-pressed={selected === provider}
              disabled={busy || !state}
              onClick={(): void => {
                if (provider !== selected)
                  void onRequest({ operation: 'select-provider', provider });
              }}
            >
              {providers[provider]}
            </button>
          ),
        )}
      </div>
      {state && selected && (
        <>
          <AiStatusCard
            level={level}
            providerName={providers[selected]}
            connection={
              connection?.provider === selected ? connection : undefined
            }
            busy={busy}
            issue={Boolean(state.issue)}
            onRequest={onRequest}
            onChangePath={openPaths}
            advancedId={advancedId}
          />
          {connected && pathsNeeded && (
            <StatusNotice
              tone="warning"
              title="문서 처리 프로그램을 선택해 주세요"
            >
              아래 ‘프로그램 위치 · 문서 처리 진단’에서 프로그램 폴더와 Python
              실행 파일을 선택하세요.
            </StatusNotice>
          )}
          {state.restartRequired && (
            <p className={styles.restart} role="status">
              변경한 위치를 적용하려면 앱을 종료한 뒤 다시 열어 주세요.
            </p>
          )}
          <details
            ref={paths}
            id={advancedId}
            className={styles.aiFold}
            data-hide-closed={hideClosedPaths}
            key={selected}
          >
            <summary
              onClick={(): void => {
                if (paths.current?.open && level === 'error')
                  pathTrigger.current?.focus();
              }}
            >
              프로그램 위치 · 문서 처리 진단
              <span className={styles.chevron} aria-hidden="true">
                ›
              </span>
            </summary>
            <RuntimeDiagnostics
              state={state}
              pending={pending}
              disabled={busy || level === 'waiting'}
              providerName={providers[selected]}
              providerPathRef={pathButton}
              onRequest={onRequest}
            />
          </details>
          {showUsage && (
            <details ref={usageFold} className={styles.aiFold}>
              <summary>
                계정 사용량 (참고)
                <span className={styles.foldHint}>
                  {selected === 'claude'
                    ? 'Claude는 한도 수치를 제공하지 않아요'
                    : 'Codex 계정 잔여 한도 보기'}
                </span>
                <span className={styles.chevron} aria-hidden="true">
                  ›
                </span>
              </summary>
              {accountUsage}
            </details>
          )}
        </>
      )}
    </section>
  );
}
