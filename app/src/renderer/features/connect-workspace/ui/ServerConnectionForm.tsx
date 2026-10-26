import type { JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ConnectRequest } from '@contracts/connection.contract';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { serverConnectionSchema } from '../model/connectionForm.schema';
import type { ServerConnectionValues } from '../model/connectionForm.schema';
import styles from './ConnectWorkspace.module.scss';

type ServerConnectionFormProps = {
  initialServerUrl: string;
  initiallyRemembered: boolean;
  busy: boolean;
  onConnect: (request: ConnectRequest) => Promise<void>;
};

/** 연결 입력의 임시 상태와 검증을 소유하고 제출 직후 폼의 비밀 입력을 비웁니다. */
export function ServerConnectionForm({
  initialServerUrl,
  initiallyRemembered,
  busy,
  onConnect,
}: ServerConnectionFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors },
  } = useForm<ServerConnectionValues, unknown>({
    resolver: zodResolver(serverConnectionSchema),
    defaultValues: {
      serverUrl: initialServerUrl,
      token: '',
      remember: initiallyRemembered,
    },
  });

  /** 검증된 요청을 전달하기 전에 DOM과 RHF에 남은 토큰 입력을 비웁니다. */
  function submitConnection(values: ServerConnectionValues): void {
    // 비밀 필드 초기화가 제출 객체의 참조에 영향을 주지 않도록 전송값을 먼저 고정합니다.
    const request: ConnectRequest = {
      serverUrl: values.serverUrl,
      token: values.token,
      remember: values.remember,
    };
    resetField('token');
    void onConnect(request);
  }

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit(submitConnection)}
      noValidate
    >
      <TextField
        {...register('serverUrl')}
        label="서버 주소"
        type="url"
        required
        error={errors.serverUrl?.message}
        placeholder="https://wiki.example.com"
        disabled={busy}
        description="HTTPS 주소를 입력합니다. 같은 PC의 로컬 서버는 HTTP도 사용할 수 있습니다."
        autoComplete="url"
      />
      <TextField
        {...register('token')}
        label="개인 토큰"
        type="password"
        required
        error={errors.token?.message}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        description="서버에서 발급받은 개인 토큰만 입력합니다."
      />
      <label className={styles.remember}>
        <input type="checkbox" {...register('remember')} disabled={busy} />
        이 PC에 연결을 보호 저장하고 다시 열 때 복원
      </label>
      <p className={styles.note}>
        OS 보호 저장을 사용할 수 없으면 이번 실행에서만 사용합니다. 체크하지
        않고 새로 연결하면 이전에 저장한 연결을 삭제합니다. 서버 인증과 개인 AI
        로그인은 별도입니다.
      </p>
      <Button type="submit" disabled={busy}>
        서버 연결 확인
      </Button>
    </form>
  );
}
