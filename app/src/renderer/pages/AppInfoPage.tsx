import type { JSX } from 'react';
import type { GetAppInfoResponse } from '@contracts/app.contract';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';

type AppInfoPageProps = {
  info: GetAppInfoResponse | null;
  error: string | null;
};

/** 공개 실행 정보를 표시합니다. 연결 성공이나 서버 권한으로 해석하지 않습니다. */
export function AppInfoPage({ info, error }: AppInfoPageProps): JSX.Element {
  return (
    <section className="info-page" aria-labelledby="info-title">
      <p className="eyebrow">DESKTOP APPLICATION</p>
      <h1 id="info-title">앱 정보</h1>
      <p className="page-description">
        현재 실행 중인 데스크톱 앱의 정보입니다.
      </p>
      {error ? (
        <StatusNotice tone="error" title="앱 정보를 불러오지 못했습니다">
          {error}
        </StatusNotice>
      ) : info ? (
        <dl className="app-info">
          <div>
            <dt>앱</dt>
            <dd>{info.name}</dd>
          </div>
          <div>
            <dt>버전</dt>
            <dd>{info.version}</dd>
          </div>
          <div>
            <dt>Electron</dt>
            <dd>{info.electronVersion}</dd>
          </div>
          <div>
            <dt>운영체제</dt>
            <dd>{info.platform}</dd>
          </div>
        </dl>
      ) : (
        <StatusNotice title="앱 정보를 확인하고 있습니다">
          잠시만 기다려 주세요.
        </StatusNotice>
      )}
      <p className="welcome-note">
        자료 서비스 상태는 서버 연결 화면에서 확인할 수 있습니다.
      </p>
    </section>
  );
}
