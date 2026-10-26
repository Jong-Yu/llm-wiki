import type { JSX } from 'react';
import { Link } from 'react-router';
import { Panel } from '@renderer/shared/ui/Panel';

/** 샘플 문서나 모의 연결 결과 없이 첫 실행 상태를 안내합니다. */
export function HomePage(): JSX.Element {
  return (
    <section className="welcome-page" aria-labelledby="welcome-title">
      <p className="eyebrow">LLM WIKI · DESKTOP</p>
      <h1 id="welcome-title">
        지식이 쌓이는
        <br />
        나의 작업 공간
      </h1>
      <p className="welcome-description">
        문서를 읽고, 지식을 연결하고, 검토한 내용을 다시 활용합니다.
      </p>
      <Panel className="setup-panel" aria-label="앱 실행 안내">
        <span className="setup-indicator" aria-hidden="true" />
        <div>
          <h2>자료 서버 연결</h2>
          <p>서버 주소와 개인 토큰을 확인하고 사용할 작업 공간을 선택하세요.</p>
        </div>
        <Link className="text-link" to="/setup/connection">
          서버 연결하기 <span aria-hidden="true">↗</span>
        </Link>
      </Panel>
      <p className="welcome-note">
        작업 공간을 선택한 뒤 해당 공간의 자료를 사용하는 화면을 연결합니다.
      </p>
    </section>
  );
}
