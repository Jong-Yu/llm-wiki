import { Button } from '@renderer/shared/ui/Button';
import { useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import type { ImportScope } from '../api/importRegistration.api';
import { importScopeKey } from '../api/importRegistration.api';
import {
  newRegistrationSession,
  registrationSession,
} from '../model/ImportRegistrationSession';
import type { ImportRegistrationSession } from '../model/ImportRegistrationSession';
import { useImportScope } from '../model/useImportScope';
import { ImportDocumentForm } from './ImportDocumentForm';
import { ImportDocumentProgress } from './ImportDocumentProgress';
import styles from './ImportDocumentContent.module.scss';

type ImportWorkspaceProps = { scope: ImportScope; onRefreshScope: () => void };

/** 권한 범위별 입력과 원본 저장 이후 처리를 별도 수명으로 표시합니다. */
function ImportWorkspace({
  scope,
  onRefreshScope,
}: ImportWorkspaceProps): JSX.Element {
  const [session, setSession] = useState<ImportRegistrationSession>(
    (): ImportRegistrationSession => registrationSession(scope),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
      <ImportDocumentProgress
        key={state.completed.requestId}
        scope={scope}
        registered={state.completed}
        draft={state.draft}
        onNewRegistration={(): void =>
          setSession(newRegistrationSession(scope))
        }
      />
    );
  return <ImportDocumentForm session={session} scope={scope} />;
}

/** 기존 권한 선택을 읽고 신규 원본과 후속 처리의 화면을 조립합니다. */
export function ImportDocumentContent(): JSX.Element {
  const model = useImportScope();
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
  return (
    <ImportWorkspace
      key={importScopeKey(model.state.scope)}
      scope={model.state.scope}
      onRefreshScope={model.refresh}
    />
  );
}
