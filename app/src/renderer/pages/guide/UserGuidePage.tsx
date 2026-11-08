import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import styles from './UserGuidePage.module.scss';

type UserGuidePageProps = { standalone?: boolean };

/** 업무 bridge에 접근할 수 없는 프레임에서 앱에 포함한 오프라인 가이드를 읽습니다. */
export function UserGuidePage({
  standalone = false,
}: UserGuidePageProps): JSX.Element {
  const [entry, setEntry] = useState('index.html');
  const frame = useRef<HTMLIFrameElement>(null);
  const lastScene = useRef('');
  const source = new URL(`user-guide/${entry}`, document.baseURI).href;
  useEffect((): (() => void) => {
    /** 불투명 출처의 자기 프레임에서 온 고정 문서 이동만 처리합니다. */
    const navigateGuide = (event: MessageEvent<unknown>): void => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null'
      )
        return;
      const input = event.data;
      if (
        !input ||
        typeof input !== 'object' ||
        !('kind' in input) ||
        input.kind !== 'wiki-user-guide-navigation' ||
        !('page' in input) ||
        (input.page !== 'index.html' && input.page !== 'reference.html') ||
        !('fragment' in input) ||
        typeof input.fragment !== 'string' ||
        input.fragment.length > 500 ||
        (input.fragment !== '' && !input.fragment.startsWith('#'))
      )
        return;
      if (
        'scene' in input &&
        typeof input.scene === 'string' &&
        /^[a-z-]{1,80}$/.test(input.scene)
      )
        lastScene.current = `#${input.scene}`;
      const fragment =
        input.fragment ||
        (input.page === 'index.html' ? lastScene.current : '');
      setEntry(`${input.page}${fragment}`);
    };
    window.addEventListener('message', navigateGuide);
    return (): void => window.removeEventListener('message', navigateGuide);
  }, []);
  return (
    <section
      className={styles.page}
      data-standalone={standalone || undefined}
      aria-label="사용자 가이드"
    >
      {standalone && (
        <header className={styles.heading}>
          <h1>사용자 가이드</h1>
          <Link to="/documents">로그인으로 돌아가기</Link>
        </header>
      )}
      <iframe
        ref={frame}
        className={styles.frame}
        src={source}
        title="LLM Wiki 화면 사용자 가이드"
        sandbox="allow-scripts allow-popups"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
