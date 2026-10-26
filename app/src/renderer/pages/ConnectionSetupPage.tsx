import { Link } from 'react-router';
import type { JSX } from 'react';
import { ConnectWorkspace } from '@renderer/features/connect-workspace';

/** 서버 미설정·인증 실패에서도 진입할 수 있는 연결 화면입니다. */
export function ConnectionSetupPage(): JSX.Element {
  return (
    <>
      <ConnectWorkspace />
      <p className="welcome-note">
        저장된 연결 삭제는 인증정보만 지웁니다. 작업 공간을 선택한 상태에서
        연결을 해제하면 현재 서버·사용자의 로컬 복구 자료도 삭제합니다. 선택
        없이 해제하면 암호화된 복구 자료는 보존됩니다.
      </p>
      <nav className="workspace-settings-links" aria-label="작업 공간 안내">
        <Link to="/setup/runtime">개인 실행 환경</Link>
        <Link to="/about">앱 정보</Link>
      </nav>
    </>
  );
}
