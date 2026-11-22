import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, SubmitEvent, SyntheticEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { AccountRequest } from '@contracts/connection.contract';
import { AppShell } from '@renderer/app/AppShell';
import { BrandMark } from '@renderer/shared/ui/BrandMark';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  useResolvedTheme,
  useThemePreference,
} from '@renderer/shared/theme/useThemePreference';
import { ServerAccessForm } from '@renderer/features/configure-workspace-tools/ui/ServerAccessForm';
import { PersonalAiSettings } from '@renderer/features/configure-workspace-tools/ui/PersonalAiSettings';
import { ThemeSettings } from '@renderer/features/configure-workspace-tools/ui/ThemeSettings';
import { toolsConnectionSchema } from '@renderer/features/configure-workspace-tools/model/workspaceTools.schema';
import settingsPage from '@renderer/pages/settings/ConnectionSettingsPage.module.scss';
import common from '@renderer/features/configure-workspace-tools/ui/WorkspaceTools.module.scss';
import { IconAction } from './controls';
import { previewRuntime, setPreviewAccount } from './previewEnvironment';
import styles from './EntryScreens.module.scss';

export type EntryScreen = 'login' | 'waiting' | 'settings' | 'auth';
export type AdminAuthError =
  | 'invalid'
  | 'offline'
  | 'unconfigured'
  | 'expired'
  | 'denied'
  | null;
type EntryScreensProps = {
  screen: EntryScreen;
  serverUrl: string;
  userName: string;
  authError: AdminAuthError;
  onEnterAdmin: (serverUrl: string) => void;
  onCancelAdmin: () => void;
  onAuthenticate: (serverUrl: string, key: string) => Promise<AdminAuthError>;
  onUserLogin: (name: string, serverUrl: string, waiting: boolean) => void;
  onUserLogout: () => void;
  onCheckAssignment?: () => void;
  onOpenGuide?: () => void;
};
const authenticationSchema = toolsConnectionSchema
  .pick({ serverUrl: true })
  .extend({
    key: z
      .string()
      .min(1, '관리자 키를 입력해 주세요.')
      .max(4096, '관리자 키를 확인해 주세요.'),
  });
type AuthenticationValues = z.infer<typeof authenticationSchema>;
const authMessages: Record<
  Exclude<AdminAuthError, null>,
  { title: string; detail: string }
> = {
  invalid: {
    title: '관리자 키를 확인해 주세요',
    detail: '입력한 키로 인증할 수 없습니다. 다시 입력해 주세요.',
  },
  offline: {
    title: '서버에 연결할 수 없습니다',
    detail: '서버 주소와 연결 상태를 확인한 뒤 다시 시도해 주세요.',
  },
  unconfigured: {
    title: '관리자 인증이 준비되지 않았습니다',
    detail: '서버 운영자가 로컬에서 관리자 키를 설정해야 합니다.',
  },
  expired: {
    title: '관리자 인증이 만료되었습니다',
    detail: '계속하려면 관리자 키로 다시 로그인해 주세요.',
  },
  denied: {
    title: '관리 권한을 확인할 수 없습니다',
    detail: '서버 관리용 키를 확인한 뒤 다시 로그인해 주세요.',
  },
};
type AdminAuthenticationProps = Pick<
  EntryScreensProps,
  'serverUrl' | 'authError' | 'onAuthenticate' | 'onCancelAdmin'
>;

/** 관리자 키는 이 폼의 입력에만 두고 제출·취소·해제 시 즉시 비웁니다. */
function AdminAuthentication({
  serverUrl,
  authError,
  onAuthenticate,
  onCancelAdmin,
}: AdminAuthenticationProps): JSX.Element {
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<AuthenticationValues>({
    resolver: zodResolver(authenticationSchema),
    defaultValues: { serverUrl, key: '' },
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AdminAuthError>(null);
  const lifecycle = useRef({ live: false, generation: 0, submitting: false });
  useEffect((): void => {
    setFocus(serverUrl.trim() ? 'key' : 'serverUrl');
  }, [serverUrl, setFocus]);
  useEffect((): (() => void) => {
    const state = lifecycle.current;
    state.live = true;
    return (): void => {
      state.live = false;
      state.generation++;
      state.submitting = false;
      setValue('key', '');
    };
  }, [setValue]);
  async function submit(values: AuthenticationValues): Promise<void> {
    const state = lifecycle.current;
    if (state.submitting) return;
    const request = ++state.generation;
    state.submitting = true;
    setBusy(true);
    setFailure(null);
    let key = values.key;
    values.key = '';
    setValue('key', '', { shouldDirty: false });
    let result: AdminAuthError;
    try {
      result = await onAuthenticate(values.serverUrl, key);
    } catch {
      result = 'offline';
    } finally {
      key = '';
    }
    if (!state.live || request !== state.generation) return;
    setFailure(result);
    state.submitting = false;
    setBusy(false);
  }
  function cancel(): void {
    lifecycle.current.generation++;
    lifecycle.current.submitting = false;
    setValue('key', '', { shouldDirty: false });
    onCancelAdmin();
  }
  const error = failure ?? authError;
  return (
    <>
      <h2 className={styles.authTitle}>관리자 로그인</h2>
      <p className={styles.authIntro}>서버 관리용 키로 로그인하세요.</p>
      {error && (
        <StatusNotice
          tone={error === 'expired' ? 'warning' : 'error'}
          title={authMessages[error].title}
        >
          {authMessages[error].detail}
        </StatusNotice>
      )}
      <form
        className={common.form}
        aria-label="관리자 로그인"
        aria-busy={busy}
        noValidate
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          void handleSubmit(submit)(event);
        }}
      >
        <fieldset className={common.fields} disabled={busy}>
          <legend className={common.visuallyHidden}>관리자 인증 정보</legend>
          <TextField
            {...register('serverUrl')}
            label="서버 주소"
            type="url"
            autoComplete="url"
            spellCheck={false}
            error={errors.serverUrl?.message}
          />
          <TextField
            {...register('key')}
            label="관리자 키"
            type="password"
            autoComplete="off"
            spellCheck={false}
            error={errors.key?.message}
          />
          <Button
            variant="primary"
            type="submit"
            className={`${common.primaryButton} ${common.accountSubmit}`}
          >
            {busy ? '인증 중…' : '관리자 로그인'}
          </Button>
        </fieldset>
        <p className={common.note}>
          시안 키: <code>demo-admin</code> · 실제 키는 입력하지 마세요.
        </p>
        <button type="button" className={common.textButton} onClick={cancel}>
          돌아가기
        </button>
      </form>
    </>
  );
}

type SettingsEntryProps = Pick<
  EntryScreensProps,
  'serverUrl' | 'userName' | 'onEnterAdmin' | 'onUserLogout'
>;
/** 계정 카드의 실제 구조와 설정 탭을 재사용해 서버 관리 진입 행만 추가합니다. */
function SettingsEntry({
  serverUrl,
  userName,
  onEnterAdmin,
  onUserLogout,
}: SettingsEntryProps): JSX.Element {
  const [tab, setTab] = useState('account');
  const [checked, setChecked] = useState(false);
  const [aiNotice, setAiNotice] = useState(false);
  const { preference, setPreference } = useThemePreference();
  useLayoutEffect(
    (): void => setPreviewAccount(userName, serverUrl),
    [userName, serverUrl],
  );
  return (
    <div className={styles.settingsFrame}>
      <AppShell>
        <div className={settingsPage.page}>
          <div className={common.layout}>
            <div className={common.main}>
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
                        className={common.section}
                        aria-label="서버·계정"
                      >
                        <div className={common.card}>
                          <span className={common.avatar} aria-hidden="true">
                            {Array.from(userName)[0]}
                          </span>
                          <div>
                            <strong>{userName}</strong>
                            <div className={common.note}>
                              {serverUrl.replace(/\/api\/v1\/?$/, '')}
                            </div>
                          </div>
                          <div className={common.cardActions}>
                            <span className={common.goodBadge}>연결됨</span>
                            <button
                              type="button"
                              className={common.textButton}
                              onClick={(): void => setChecked(true)}
                            >
                              연결 확인
                            </button>
                            <Button
                              variant="surface"
                              type="button"
                              className={common.button}
                              onClick={onUserLogout}
                            >
                              로그아웃
                            </Button>
                          </div>
                          <div className={common.cardFooter}>
                            <p className={common.note}>
                              현재 작업 공간 <strong>SDV 플랫폼</strong>
                            </p>
                          </div>
                        </div>
                        {checked && (
                          <p className={common.note} role="status">
                            시안의 연결 상태를 확인했습니다.
                          </p>
                        )}
                        <div className={styles.adminEntry}>
                          <div>
                            <h2>서버 관리</h2>
                            <p className={common.note}>
                              워크스페이스와 사용자 배정을 관리합니다.
                            </p>
                          </div>
                          <Button
                            variant="surface"
                            data-admin-entry=""
                            onClick={(): void => onEnterAdmin(serverUrl)}
                          >
                            관리자 콘솔 열기
                          </Button>
                        </div>
                      </section>
                    ),
                  },
                  {
                    id: 'ai',
                    label: 'AI 실행',
                    content: (
                      <>
                        {aiNotice && (
                          <StatusNotice
                            tone="info"
                            title="시안에서는 AI 설정을 변경하지 않습니다"
                          />
                        )}
                        <PersonalAiSettings
                          state={previewRuntime.ok ? previewRuntime.data : null}
                          pending={null}
                          error={null}
                          onRequest={async (): Promise<void> =>
                            setAiNotice(true)
                          }
                          usageLinkKey={null}
                        />
                      </>
                    ),
                  },
                  {
                    id: 'appearance',
                    label: '화면',
                    content: (
                      <ThemeSettings
                        preference={preference}
                        onChange={setPreference}
                      />
                    ),
                  },
                ]}
              />
            </div>
          </div>
        </div>
      </AppShell>
    </div>
  );
}

/** 일반 로그인·배정 대기·설정에서 독립 관리자 인증 화면으로 연결합니다. */
export function EntryScreens(props: EntryScreensProps): JSX.Element {
  const {
    screen,
    serverUrl,
    userName,
    onEnterAdmin,
    onUserLogin,
    onUserLogout,
    onCheckAssignment,
    onOpenGuide,
  } = props;
  const theme = useResolvedTheme();
  const [waitingChecked, setWaitingChecked] = useState(false);
  const [serverDraft, setServerDraft] = useState({
    base: serverUrl,
    value: serverUrl,
  });
  const entryServerUrl =
    serverDraft.base === serverUrl ? serverDraft.value : serverUrl;
  if (screen === 'settings') return <SettingsEntry {...props} />;
  return (
    <main
      className={`wiki-theme ${common.loginPage} ${styles.entryPage}`}
      data-wiki-theme={theme}
    >
      <section
        className={`${common.section} ${common.login}`}
        aria-labelledby="entry-brand"
      >
        <h1 id="entry-brand" className={common.loginBrand}>
          <BrandMark className={common.loginMark} />
          LLM Wiki
        </h1>
        {screen === 'auth' ? (
          <AdminAuthentication {...props} />
        ) : (
          <>
            {screen === 'waiting' ? (
              <section
                className={common.assignmentWaiting}
                aria-labelledby="entry-waiting-title"
              >
                <h2 id="entry-waiting-title">워크스페이스 배정 대기</h2>
                <p>
                  로그인했습니다. 관리자가 워크스페이스를 배정하면 사용할 수
                  있습니다.
                </p>
                <div
                  className={`${common.assignmentActions} ${styles.waitingActions}`}
                >
                  <IconAction
                    label="워크스페이스 배정 다시 확인"
                    icon="refresh-cw"
                    onClick={(): void => {
                      setWaitingChecked(true);
                      onCheckAssignment?.();
                    }}
                  />
                  <IconAction
                    label="로그아웃"
                    icon="log-out"
                    onClick={onUserLogout}
                  />
                </div>
                {waitingChecked && (
                  <p className={common.note} role="status">
                    아직 배정된 워크스페이스가 없습니다.
                  </p>
                )}
              </section>
            ) : (
              <div
                onChangeCapture={(
                  event: SyntheticEvent<HTMLDivElement>,
                ): void => {
                  if (
                    event.target instanceof HTMLInputElement &&
                    event.target.name === 'serverUrl'
                  )
                    setServerDraft({
                      base: serverUrl,
                      value: event.target.value,
                    });
                }}
              >
                <ServerAccessForm
                  serverUrl={serverUrl}
                  name={userName}
                  busy={false}
                  isConnecting={false}
                  onConnect={async (request: AccountRequest): Promise<void> =>
                    onUserLogin(
                      request.name,
                      request.serverUrl,
                      request.mode === 'signup',
                    )
                  }
                  onModeChange={(): void => {}}
                />
              </div>
            )}
            <div className={styles.entryLinks}>
              {onOpenGuide && (
                <button
                  type="button"
                  className={common.textButton}
                  onClick={onOpenGuide}
                >
                  사용자 가이드
                </button>
              )}
              <button
                type="button"
                data-admin-entry=""
                className={common.textButton}
                onClick={(): void => onEnterAdmin(entryServerUrl)}
              >
                관리자 로그인
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
