import styles from './ConfigureRuntime.module.scss';
import type { JSX } from 'react';
import { Link } from 'react-router';
import type {
  RuntimePathKind,
  RuntimeCheck,
  AiProvider,
} from '@contracts/runtime.contract';
import { useRuntimeSettings } from '../model/useRuntimeSettings';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';

const paths: { kind: RuntimePathKind; label: string }[] = [
  { kind: 'root', label: '개인 실행 환경 폴더' },
  { kind: 'python', label: 'Python 실행 파일' },
  { kind: 'codex', label: 'Codex CLI' },
  { kind: 'claude', label: 'Claude Code CLI' },
  { kind: 'tesseract', label: 'Tesseract 실행 파일 (선택)' },
  { kind: 'tessdata', label: 'OCR 언어 데이터 폴더 (선택)' },
];
const providers: { value: AiProvider; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
];
/** 로컬 설치 경로와 읽기 전용 진단을 보여주고 명시 저장 뒤 재시작을 안내합니다. */
export function ConfigureRuntime(): JSX.Element {
  const { state, busy, error, run } = useRuntimeSettings();
  return (
    <section
      className={`info-page ${styles.page}`}
      aria-labelledby="runtime-title"
    >
      <p className="eyebrow">PERSONAL RUNTIME</p>
      <h1 id="runtime-title">개인 실행 환경</h1>
      <p className="page-description">
        분석·질문·문자 변환에 사용할 이 PC의 실행 환경입니다. 서버 연결은 별도로
        확인합니다.
      </p>
      {error && <StatusNotice tone="error">{error}</StatusNotice>}
      {state?.issue && (
        <StatusNotice tone="warning">{state.issue}</StatusNotice>
      )}
      <div
        className="workspace-settings-links"
        role="group"
        aria-label="다음 시작에 사용할 AI CLI"
      >
        {providers.map(
          ({
            value,
            label,
          }: {
            value: AiProvider;
            label: string;
          }): JSX.Element => (
            <Button
              key={value}
              variant={
                state?.settings.provider === value ? 'primary' : 'secondary'
              }
              aria-pressed={state?.settings.provider === value}
              disabled={busy || !state}
              onClick={(): void => {
                void run({ operation: 'select-provider', provider: value });
              }}
            >
              {label}
            </Button>
          ),
        )}
      </div>
      {state && (
        <p>
          현재 실행:{' '}
          {state.activeProvider === 'claude' ? 'Claude Code' : 'Codex'} · 다음
          시작 선택:{' '}
          {state.settings.provider === 'claude' ? 'Claude Code' : 'Codex'}.
          선택한 제공자는 저장한 뒤 앱을 다시 시작하면 분석·질문·추출안에
          적용됩니다.
        </p>
      )}
      <dl className="app-info">
        {paths.map(
          ({
            kind,
            label,
          }: {
            kind: RuntimePathKind;
            label: string;
          }): JSX.Element => (
            <div key={kind}>
              <dt>{label}</dt>
              <dd>
                <code>{state?.settings[kind] || '선택하지 않음'}</code>{' '}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={(): void => {
                    void run({ operation: 'choose', kind });
                  }}
                >
                  {label} 선택
                </Button>
              </dd>
            </div>
          ),
        )}
      </dl>
      <div className="workspace-settings-links">
        <Button
          disabled={busy || !state}
          onClick={(): void => {
            void run({ operation: 'diagnose' });
          }}
        >
          {busy ? '확인 중…' : '설치·로그인 진단'}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !state || Boolean(state.issue)}
          onClick={(): void => {
            void run({ operation: 'save' });
          }}
        >
          다음 시작에 적용하도록 저장
        </Button>
      </div>
      {state?.saved && (
        <StatusNotice
          tone={state.restartRequired ? 'warning' : 'success'}
          title={
            state.restartRequired
              ? '설정을 저장했습니다. 앱을 완전히 종료하고 다시 열어 주세요.'
              : '저장된 실행 환경 설정'
          }
        >
          진행 중인 작업의 실행 환경은 유지합니다.
        </StatusNotice>
      )}
      {state?.checks.map((check: RuntimeCheck): JSX.Element => (
        <StatusNotice
          key={check.name}
          tone={
            check.status === 'ok'
              ? 'success'
              : check.status === 'error'
                ? 'error'
                : 'warning'
          }
          title={`${check.name} · ${check.status}`}
        >
          {check.detail}
        </StatusNotice>
      ))}
      <h2>설치·업데이트·복구</h2>
      <ol>
        <li>Python 3.12 이상과 배포받은 개인 실행 환경 폴더를 준비합니다.</li>
        <li>
          터미널에서 해당 폴더로 이동한 뒤{' '}
          <code>python3 -m tools.setup_runtime --role personal</code>을
          실행합니다. Windows에서는 <code>py -3.12</code>를 사용합니다.
        </li>
        <li>
          폴더 안의 <code>.venv/bin/python</code> (Windows:{' '}
          <code>.venv/Scripts/python.exe</code>)을 선택합니다.
        </li>
        <li>
          사용할 Codex 또는 Claude Code CLI를 설치하고 개인 계정으로 로그인한 뒤
          각각의 실행 파일을 선택합니다. 앱 진단은 로그인 정보 존재만
          확인합니다.
        </li>
        <li>
          OCR이 필요하면 Tesseract와 사용할 언어 데이터(한국어 kor, 영어 eng)를
          설치하고 해당 경로를 선택합니다.
        </li>
      </ol>
      <p>
        고정 의존성을 다시 설치하려면 같은 명령에 <code>--upgrade</code>를
        추가합니다. 실패한 설치를 복구할 때도 기존 폴더·자료를 삭제하지 말고
        진단을 다시 실행하세요.
      </p>
      <p>
        앱 업데이트는 제공받은 새 설치 파일로 교체합니다. 자동 다운로드·공개
        배포 채널은 아직 구성하지 않았습니다.
      </p>
      <nav className="workspace-settings-links" aria-label="실행 환경 안내">
        <Link to="/setup/connection">서버 연결</Link>
        <Link to="/about">앱 정보</Link>
      </nav>
    </section>
  );
}
