import { Button } from '@renderer/shared/ui/Button';
import { useId, useState } from 'react';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { AccountRequest } from '@contracts/connection.contract';
import { TextField } from '@renderer/shared/ui/TextField';
import { toolsConnectionSchema } from '../model/workspaceTools.schema';
import type { ToolsConnectionValues } from '../model/workspaceTools.schema';
import styles from './WorkspaceTools.module.scss';

type ServerAccessFormProps = {
  serverUrl: string;
  name: string;
  /** 기억한 이름·서버가 있으면 한 줄로 보여 주고 로그인만 누르게 합니다. */
  remembered?: boolean;
  busy: boolean;
  isConnecting: boolean;
  onConnect: (request: AccountRequest) => Promise<void>;
  onModeChange: () => void;
};

/** 이름과 한 서버 주소만 입력받으며 인증 비밀은 main에서 자동 처리합니다. */
export function ServerAccessForm({
  serverUrl,
  name,
  remembered = false,
  busy,
  isConnecting,
  onConnect,
  onModeChange,
}: ServerAccessFormProps): JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [editing, setEditing] = useState(false);
  const modeId = useId();
  const {
    register,
    handleSubmit,
    clearErrors,
    control,
    formState: { errors },
  } = useForm<ToolsConnectionValues>({
    resolver: zodResolver(toolsConnectionSchema),
    defaultValues: { serverUrl, name },
  });
  const [nameValue, serverValue] = useWatch({
    control,
    name: ['name', 'serverUrl'],
  });
  const showRemembered =
    remembered && !editing && mode === 'login' && !!name && !!serverUrl;
  const filled = !!nameValue?.trim() && !!serverValue?.trim();
  /** 명시한 가입 또는 로그인만 수행하며 실패를 다른 작업으로 바꾸지 않습니다. */
  function submit(values: ToolsConnectionValues): void {
    void onConnect({ ...values, mode });
  }
  /** 입력은 보존하고 선택한 동작과 무관해진 이전 오류만 지웁니다. */
  function changeMode(next: 'login' | 'signup'): void {
    if (busy || next === mode) return;
    setMode(next);
    clearErrors();
    onModeChange();
  }
  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit(submit)}
      aria-busy={busy}
      noValidate
    >
      <fieldset className={styles.accountModes} disabled={busy}>
        <legend className={styles.visuallyHidden}>계정 연결 방식</legend>
        <label>
          <input
            className={styles.visuallyHidden}
            type="radio"
            name={`${modeId}-mode`}
            value="login"
            checked={mode === 'login'}
            onChange={(): void => changeMode('login')}
          />
          <span>로그인</span>
        </label>
        <label>
          <input
            className={styles.visuallyHidden}
            type="radio"
            name={`${modeId}-mode`}
            value="signup"
            checked={mode === 'signup'}
            onChange={(): void => changeMode('signup')}
          />
          <span>회원가입</span>
        </label>
      </fieldset>
      {showRemembered && (
        <div className={styles.rememberedCard}>
          <span className={styles.avatar} aria-hidden="true">
            {Array.from(name)[0]}
          </span>
          <div>
            <strong>{name}</strong>
            <div className={styles.note}>
              {serverUrl.replace(/\/api\/v1\/?$/, '')}
            </div>
          </div>
          <button
            type="button"
            className={styles.textButton}
            disabled={busy}
            onClick={(): void => setEditing(true)}
          >
            변경
          </button>
        </div>
      )}
      <fieldset disabled={busy} className={styles.fields}>
        <legend className={styles.visuallyHidden}>
          {mode === 'signup' ? '회원가입 정보' : '로그인 정보'}
        </legend>
        {!showRemembered && (
          <>
            <TextField
              {...register('name')}
              label="계정 이름"
              autoComplete="username"
              spellCheck={false}
              placeholder={mode === 'signup' ? '사용할 이름' : '가입한 이름'}
              error={errors.name?.message}
            />
            <TextField
              {...register('serverUrl')}
              label="서버 주소"
              type="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://wiki.example.com"
              error={errors.serverUrl?.message}
            />
          </>
        )}
        <Button
          variant="primary"
          className={`${styles.primaryButton} ${styles.accountSubmit}`}
          type="submit"
          disabled={!filled}
        >
          {isConnecting
            ? mode === 'signup'
              ? '가입 중…'
              : '로그인 중…'
            : mode === 'signup'
              ? '가입하고 시작'
              : '로그인'}
        </Button>
      </fieldset>
    </form>
  );
}
