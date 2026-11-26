import { Button } from '@renderer/shared/ui/Button';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  documentTaskPath,
  workflowReturnTo,
} from '@renderer/shared/lib/workflowNavigation';
import type { ImportProcessingSession } from '../model/ImportProcessingSession';
import type {
  ImportReplacementResult,
  ImportScope,
} from '../api/importRegistration.api';
import {
  importScopeKey,
  readImportReplacement,
} from '../api/importRegistration.api';
import {
  newRegistrationSession,
  registrationSession,
  retainedReplacementSession,
} from '../model/ImportRegistrationSession';
import type { ImportRegistrationSession } from '../model/ImportRegistrationSession';
import { useImportScope } from '../model/useImportScope';
import { ImportDocumentForm } from './ImportDocumentForm';
import styles from './ImportDocumentContent.module.scss';
import { importProcessingSession } from '../model/importProcessingSessions';
import { findSourceTask } from '../api/importProcessing.api';
import type { ImportProcessingResult } from '../model/importProcessing.types';

type ImportWorkspaceProps = {
  scope: ImportScope;
  onRefreshScope: () => void;
  replacementSession?: ImportRegistrationSession;
  returnTo?: string;
};
type ReplacementWorkspaceProps = {
  scope: ImportScope;
  sourceId: string;
  version: string;
  returnTo: string;
  onRefreshScope: () => void;
};
type RegisteredTaskProps = {
  session: ImportProcessingSession;
  onLeave: () => void;
};
type LegacySourceTaskProps = {
  scope: ImportScope;
  sourceId: string;
  version: string;
};

/** 같은 교체 요청을 먼저 복원하고 새 진입에서만 현재 판본을 읽어 교체 대상을 고정합니다. */
function ReplacementWorkspace({
  scope,
  sourceId,
  version,
  returnTo,
  onRefreshScope,
}: ReplacementWorkspaceProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [session, setSession] = useState<ImportRegistrationSession | null>(
    (): ImportRegistrationSession | null =>
      retainedReplacementSession(scope, sourceId, version),
  );
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect((): (() => void) => {
    let current = true;
    if (active && !session) {
      void readImportReplacement(scope, sourceId, version).then(
        (result: ImportReplacementResult): void => {
          if (!current) return;
          if (result.ok) setSession(registrationSession(scope, result.data));
          else setError(result.message);
        },
      );
    }
    return (): void => {
      current = false;
    };
  }, [active, scope, sourceId, version, session, retry]);
  if (session)
    return (
      <ImportWorkspace
        scope={scope}
        onRefreshScope={onRefreshScope}
        replacementSession={session}
        returnTo={returnTo}
      />
    );
  return (
    <section className={styles.notice} role={error ? 'alert' : 'status'}>
      <p>{error ?? '교체할 원본을 확인하고 있습니다…'}</p>
      {error && (
        <Button
          onClick={(): void => {
            setError(null);
            setRetry((value: number): number => value + 1);
          }}
        >
          다시 확인
        </Button>
      )}
      <Link to={returnTo}>진행 상태로 돌아가기</Link>
    </section>
  );
}

/** 이전 등록 진행 주소는 메모리 수명과 무관하게 보존된 같은 작업으로 연결합니다. */
function LegacySourceTask({
  scope,
  sourceId,
  version,
}: LegacySourceTaskProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [result, setResult] = useState<ImportProcessingResult<
    string | null
  > | null>(null);
  useEffect((): (() => void) => {
    let current = true;
    if (active)
      void findSourceTask(scope, sourceId, version).then(
        (next: ImportProcessingResult<string | null>): void => {
          if (current) setResult(next);
        },
      );
    return (): void => {
      current = false;
    };
  }, [active, scope, sourceId, version]);
  if (active && result?.ok && result.data)
    return (
      <Navigate
        to={documentTaskPath(result.data)}
        replace
        state={{ workflowReturnTo: '/documents' }}
      />
    );
  return (
    <section
      className={styles.notice}
      role={result && !result.ok ? 'alert' : 'status'}
    >
      <p>
        {!result
          ? '보관된 작업을 확인하고 있습니다…'
          : result.ok
            ? '이 기기의 해당 작업 기록을 찾지 못했습니다. 원본 상세에서 기존 분석 기록을 확인해 주세요.'
            : result.error.message}
      </p>
      <Link to={`/source?${new URLSearchParams({ sourceId, version })}`}>
        등록 원본 열기
      </Link>
      <Link to="/documents">문서 목록</Link>
    </section>
  );
}

/** 등록 요청이 만든 작업으로 이동하며 다시 등록 화면을 열면 새 입력을 제공합니다. */
function RegisteredTask({
  session,
  onLeave,
}: RegisteredTaskProps): JSX.Element {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const active = useWorkspaceActivity();
  const navigate = useNavigate();
  useEffect((): void => {
    if (!active || !snapshot.taskId) return;
    void navigate(documentTaskPath(snapshot.taskId), {
      replace: true,
      state: { workflowReturnTo: '/documents' },
    });
    onLeave();
  }, [active, navigate, onLeave, snapshot.taskId]);
  return (
    <section
      className={styles.notice}
      role={snapshot.error ? 'alert' : 'status'}
    >
      <p>
        {snapshot.error ?? '원본을 보관했습니다. 등록을 계속하고 있습니다…'}
      </p>
      {snapshot.error && (
        <Button
          disabled={snapshot.busy || snapshot.scopeInvalid}
          onClick={(): void => {
            void session.begin();
          }}
        >
          등록 계속
        </Button>
      )}
      <Link to="/documents">문서 목록</Link>
    </section>
  );
}

/** 권한 범위별 입력과 원본 저장 이후 처리를 별도 수명으로 표시합니다. */
function ImportWorkspace({
  scope,
  onRefreshScope,
  replacementSession,
  returnTo,
}: ImportWorkspaceProps): JSX.Element {
  const [session, setSession] = useState<ImportRegistrationSession>(
    (): ImportRegistrationSession =>
      replacementSession ?? registrationSession(scope),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [parameters] = useSearchParams();
  const sourceId = parameters.get('sourceId');
  const version = parameters.get('version');
  if (!replacementSession && sourceId && version) {
    return (
      <LegacySourceTask
        key={`${sourceId}:${version}`}
        scope={scope}
        sourceId={sourceId}
        version={version}
      />
    );
  }
  if (state.scopeInvalid)
    return (
      <section className={styles.notice} role="alert">
        <h2>작업 범위를 다시 확인해 주세요</h2>
        <p>{state.error}</p>
        <p>입력과 등록 요청은 원래 범위에 보관되어 있습니다.</p>
        <Button
          variant="surface"
          type="submit"
          className={styles.button}
          onClick={(): void => {
            void session.revalidateScope().then(onRefreshScope);
          }}
        >
          현재 연결 확인
        </Button>
        <Link to="/settings">연결하기</Link>
      </section>
    );
  if (state.completed)
    return (
      <RegisteredTask
        session={importProcessingSession(scope, state.completed, state.draft)}
        onLeave={(): void => {
          if (!replacementSession) setSession(newRegistrationSession(scope));
        }}
      />
    );
  return (
    <ImportDocumentForm session={session} scope={scope} returnTo={returnTo} />
  );
}

/** 기존 권한 선택을 읽고 신규 원본과 후속 처리의 화면을 조립합니다. */
export function ImportDocumentContent(): JSX.Element {
  const model = useImportScope();
  const [parameters] = useSearchParams();
  const location = useLocation();
  if (model.state.status === 'loading')
    return (
      <p className={styles.notice} role="status">
        작업 공간을 확인하고 있습니다…
      </p>
    );
  if (model.state.status !== 'ready')
    return (
      <section
        className={styles.notice}
        role={model.state.status === 'error' ? 'alert' : 'status'}
      >
        <h2>
          {model.state.status === 'error'
            ? '연결 상태를 확인하지 못했습니다'
            : '등록할 작업 공간을 선택해 주세요'}
        </h2>
        <p>
          {model.state.status === 'error'
            ? model.state.message
            : '작업 공간을 선택하면 문서를 등록할 수 있습니다.'}
        </p>
        <div className={styles.actions}>
          <Button
            variant="surface"
            type="submit"
            className={styles.button}
            onClick={model.refresh}
          >
            다시 확인
          </Button>
          <Link className={styles.button} to="/settings">
            연결하기
          </Link>
        </div>
      </section>
    );
  const replacementId = parameters.get('replaceSourceId');
  if (replacementId !== null)
    return (
      <ReplacementWorkspace
        key={`${importScopeKey(model.state.scope)}:${replacementId}:${parameters.get('version') ?? ''}`}
        scope={model.state.scope}
        sourceId={replacementId}
        version={parameters.get('version') ?? ''}
        returnTo={workflowReturnTo(location.state) ?? '/documents'}
        onRefreshScope={model.refresh}
      />
    );
  return (
    <ImportWorkspace
      key={importScopeKey(model.state.scope)}
      scope={model.state.scope}
      onRefreshScope={model.refresh}
    />
  );
}
