import type { JSX } from 'react';
import type { ConnectionProtection } from '@contracts/connection.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import styles from './ConnectWorkspace.module.scss';

type ConnectionProtectionStatusProps = {
  protection: ConnectionProtection | undefined;
  busy: boolean;
  onRestore: () => Promise<void>;
  onForget: () => Promise<void>;
};

const issueMessages: Record<ConnectionProtection['issue'], string> = {
  none: '',
  storage_unavailable:
    'OS 보호 저장소를 사용할 수 없습니다. 이번 실행에서만 연결하며 평문으로 저장하지 않습니다.',
  storage_corrupt:
    '저장 파일을 읽을 수 없습니다. 기존 파일을 보존했습니다. 저장 연결 삭제 후 새로 연결할 수 있습니다.',
  storage_busy:
    '다른 저장 작업이 진행 중입니다. 저장 파일은 바꾸지 않았습니다. 잠시 후 다시 확인해 주세요.',
  storage_changed:
    '저장 파일이 다른 곳에서 변경되었습니다. 이전 기준으로 덮어쓰지 않았습니다. 저장 연결 재확인 후 다시 시도해 주세요.',
  storage_write_failed:
    '보호 저장 또는 삭제를 완료하지 못했습니다. 저장된 연결이 남아 있으면 다음 실행에서 복원될 수 있습니다.',
  restore_failed:
    '서버 연결 또는 인증을 확인하지 못해 복원을 중단했습니다. 저장된 연결을 보존했으며 재시도할 수 있습니다.',
  identity_changed:
    '저장된 인증 사용자가 변경되어 복원을 중단했습니다. 개인 토큰을 다시 입력해 주세요.',
  scope_changed:
    '권한·작업 공간·관점이 변경되어 복원을 중단했습니다. 새로 연결해 현재 허용 범위를 선택해 주세요.',
};

/** 비밀 없는 보호 저장 상태와 명시 복원·삭제 동작을 제공합니다. */
export function ConnectionProtectionStatus({
  protection,
  busy,
  onRestore,
  onForget,
}: ConnectionProtectionStatusProps): JSX.Element {
  const protectedStorage = protection?.availability === 'protected';
  return (
    <div className={styles.protection}>
      <StatusNotice
        title={
          protection?.remembered
            ? '이 PC에 연결을 보호 저장했습니다'
            : '현재 연결은 세션 전용입니다'
        }
      >
        <p className={styles.message}>
          {protection?.issue && protection.issue !== 'none'
            ? issueMessages[protection.issue]
            : protectedStorage
              ? '보호 저장을 선택하면 다음 실행에서 서버의 현재 사용자·권한을 다시 확인합니다.'
              : '앱을 종료하면 토큰을 다시 입력해야 합니다. 보호 저장이 불가능한 환경에서는 비밀을 파일에 쓰지 않습니다.'}
        </p>
        {protection?.saved && !protection.remembered && (
          <p>
            이전에 저장한 연결이 남아 있습니다. 다음 실행의 복원을 원하지 않으면
            삭제해 주세요.
          </p>
        )}
      </StatusNotice>
      {protection?.saved && (
        <div className={styles.protectionActions}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={(): void => void onRestore()}
          >
            저장 연결 재확인
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={(): void => void onForget()}
          >
            저장된 연결 삭제
          </Button>
        </div>
      )}
    </div>
  );
}
