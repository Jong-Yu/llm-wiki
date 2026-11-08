import { Button } from '@renderer/shared/ui/Button';
import type { JSX, Ref } from 'react';
import type {
  RuntimeCheck,
  RuntimePathKind,
  RuntimeRequest,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import styles from './WorkspaceTools.module.scss';

type RuntimeDiagnosticsProps = {
  state: RuntimeSnapshot;
  pending: RuntimeRequest['operation'] | null;
  disabled: boolean;
  providerName: string;
  providerPathRef: Ref<HTMLButtonElement>;
  onRequest: (request: RuntimeRequest) => Promise<void>;
};
type RuntimePathDescription = {
  kind: RuntimePathKind;
  label: string;
  description: string;
};
const additionalPaths: RuntimePathDescription[] = [
  {
    kind: 'root',
    label: '문서 처리 프로그램 폴더',
    description:
      '배포받은 personal-runtime 폴더 또는 LLM Wiki 프로젝트 폴더를 선택하세요.',
  },
  {
    kind: 'python',
    label: 'Python 실행 파일',
    description:
      'Python 실행 파일을 선택하세요. 예: .venv/bin/python(Mac), python/python.exe(Windows 설치판).',
  },
  {
    kind: 'tesseract',
    label: '문자 인식 실행 파일 (선택)',
    description:
      '스캔 PDF·이미지를 읽으려면 tesseract(Mac) 또는 tesseract.exe(Windows)를 선택하세요.',
  },
  {
    kind: 'tessdata',
    label: '문자 인식 언어 폴더 (선택)',
    description:
      'kor.traineddata와 eng.traineddata가 들어 있는 tessdata 폴더를 선택하세요.',
  },
];

type CheckListProps = { checks: RuntimeCheck[] };

/** 진단 결과는 문제 항목부터 표시하고 성공 항목은 따로 접어 둡니다. */
function CheckList({ checks }: CheckListProps): JSX.Element {
  return (
    <dl className={styles.checks}>
      {checks.map((check: RuntimeCheck): JSX.Element => (
        <div key={check.name}>
          <dt>{check.name}</dt>
          <dd>
            <span
              className={
                check.status === 'ok' ? styles.goodText : styles.warningText
              }
            >
              {check.status === 'ok'
                ? '확인됨'
                : check.status === 'not_run'
                  ? '미실행'
                  : '확인 필요'}
            </span>
            <small>{check.detail}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 선택한 제공자의 실행 파일과 문서 처리 도구의 경로·저장·진단을 담당합니다. */
export function RuntimeDiagnostics({
  state,
  pending,
  disabled,
  providerName,
  providerPathRef,
  onRequest,
}: RuntimeDiagnosticsProps): JSX.Element {
  const selectedProvider = state.settings.provider;
  const problems = state.checks.filter(
    (check: RuntimeCheck): boolean => check.status !== 'ok',
  );
  const passed = state.checks.filter(
    (check: RuntimeCheck): boolean => check.status === 'ok',
  );
  const paths: RuntimePathDescription[] = [
    {
      kind: selectedProvider,
      label: `${providerName} 실행 파일`,
      description: `설치한 ${selectedProvider}(Mac) 또는 ${selectedProvider}.exe·${selectedProvider}.cmd(Windows) 파일을 선택하세요.`,
    },
    ...additionalPaths,
  ];

  return (
    <>
      <section className={styles.processingStatus} aria-label="문서 처리 상태">
        <h3>문서 처리 상태</h3>
        {state.checks.length === 0 && (
          <p className={styles.note}>문서 처리 진단 미실행</p>
        )}
        {state.saved && (
          <p className={styles.note} role="status">
            저장됨
          </p>
        )}
        {problems.length > 0 && <CheckList checks={problems} />}
        {passed.length > 0 && (
          <details className={styles.successfulChecks}>
            <summary>확인된 프로그램 · {passed.length}개</summary>
            <CheckList checks={passed} />
          </details>
        )}
      </section>
      <div className={styles.panel}>
        <h3>프로그램 위치 변경</h3>
        <button
          type="button"
          className={styles.textButton}
          disabled={disabled}
          onClick={(): void => {
            void onRequest({ operation: 'discover-cli' });
          }}
        >
          {pending === 'discover-cli'
            ? '실행 파일을 찾고 있습니다…'
            : 'AI 프로그램 자동으로 찾기'}
        </button>
        <dl className={styles.paths}>
          {paths.map(
            ({
              kind,
              label,
              description,
            }: RuntimePathDescription): JSX.Element => (
              <div key={kind}>
                <dt>{label}</dt>
                <dd>
                  <code>{state.settings[kind] || '설정하지 않음'}</code>
                  <Button
                    variant="surface"
                    type="button"
                    className={styles.button}
                    disabled={disabled}
                    onClick={(): void => {
                      void onRequest({ operation: 'choose', kind });
                    }}
                    ref={
                      kind === selectedProvider ? providerPathRef : undefined
                    }
                    aria-label={`${label} 선택`}
                  >
                    {kind === 'root' || kind === 'tessdata'
                      ? '폴더 선택'
                      : '파일 선택'}
                  </Button>
                </dd>
                <dd>
                  <p className={styles.note}>{description}</p>
                </dd>
              </div>
            ),
          )}
        </dl>
        <div className={styles.actionRow}>
          <Button
            variant="surface"
            type="button"
            className={styles.button}
            disabled={disabled}
            onClick={(): void => {
              void onRequest({ operation: 'diagnose' });
            }}
          >
            {pending === 'diagnose'
              ? '문서 처리 환경 확인 중…'
              : '문서 처리 환경 확인'}
          </Button>
          <Button
            variant="surface"
            type="button"
            className={styles.button}
            disabled={disabled || Boolean(state.issue)}
            onClick={(): void => {
              void onRequest({ operation: 'save' });
            }}
          >
            {pending === 'save' ? '저장 중…' : '변경한 위치 저장'}
          </Button>
        </div>
      </div>
    </>
  );
}
