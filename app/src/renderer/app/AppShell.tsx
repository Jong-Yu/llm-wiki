import { atom, useAtom } from 'jotai';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { JSX, ReactNode } from 'react';
import type {
  ConnectionResult,
  ConnectionSnapshot,
} from '@contracts/connection.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { IconButton } from '@renderer/shared/ui/IconButton';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';

const themeAtom = atom<'light' | 'dark'>('light');
type AppShellProps = { children: ReactNode };
type NavigationItem = {
  to: string;
  label: string;
  routes: readonly string[];
  icon: string;
};
type NavigationIconProps = { kind: string };
const primaryItems: readonly NavigationItem[] = [
  {
    to: '/conversations',
    label: 'AI 작업',
    routes: [
      '/conversations',
      '/analysis',
      '/analysis-plan',
      '/questions',
      '/saved-results',
      '/result-drafts',
    ],
    icon: 'chat',
  },
  {
    to: '/knowledge',
    label: '지식 탐색',
    routes: ['/knowledge', '/correspondences'],
    icon: 'knowledge',
  },
  {
    to: '/documents',
    label: '위키 문서',
    routes: ['/documents', '/comparisons', '/analysis-proposals'],
    icon: 'document',
  },
  { to: '/review', label: '검토함', routes: ['/review'], icon: 'review' },
];
const workspaceRoutes = new Set([
  ...primaryItems.flatMap(
    (item: NavigationItem): readonly string[] => item.routes,
  ),
  '/history',
]);
const recentNames: Record<string, string> = {
  '/documents': '위키 문서',
  '/analysis': 'AI 작업 목록',
  '/analysis-plan': '분석 범위·산출물',
  '/knowledge': '지식 탐색',
  '/review': '검토함',
  '/history': '변경 이력',
  '/questions': '질문 근거 준비',
  '/conversations': '질문·대화',
  '/saved-results': '결과물',
  '/result-drafts': '편집 초안·Wiki 반영',
  '/analysis-proposals': '추출안 비교·적용',
  '/comparisons': '변경 비교',
  '/correspondences': '조건·개념 대응',
};

/** 메뉴의 의미를 보조하는 장식 아이콘입니다. 이름은 링크의 텍스트가 제공합니다. */
function NavigationIcon({ kind }: NavigationIconProps): JSX.Element {
  const paths: Record<string, string> = {
    chat: 'M4 4h16v12H9l-5 4V4Z',
    knowledge: 'M12 4v6m-7 7 5-5m4 0 5 5M9 2h6v5H9zM2 17h6v5H2zM16 17h6v5h-6z',
    document: 'M6 2h8l4 4v16H6V2Zm8 0v5h4M9 11h6M9 15h6',
    review: 'M5 3h14v18H5V3Zm3 9 3 3 5-6',
    history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind] || paths.document} />
    </svg>
  );
}

/** 시안의 주요 네 화면과 하단 설정을 유지하고 세부 작업은 각 화면에서 연결합니다. */
export function AppShell({ children }: AppShellProps): JSX.Element {
  const [theme, setTheme] = useAtom(themeAtom);
  const location = useLocation();
  const [requestOpen, setRequestOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [context, setContext] = useState<{
    path: string;
    snapshot: ConnectionSnapshot;
  } | null>(null);
  const selected =
    context?.path === location.pathname &&
    context.snapshot.status === 'connected'
      ? context.snapshot.selection
      : null;
  const questionRunPage = /^\/work\/[^/]+\/question-runs(?:\/|$)/.test(
    location.pathname,
  );
  const workspacePage =
    workspaceRoutes.has(location.pathname) || questionRunPage;
  const settingsPage = [
    '/setup/connection',
    '/setup/runtime',
    '/about',
    '/',
  ].includes(location.pathname);

  useEffect((): (() => void) => {
    let active = true;
    const path = location.pathname;
    // 공개 상태는 표시용으로만 읽습니다. 권한·자료 범위 판단은 기존 feature/main이 수행합니다.
    void connectionGateway.getState().then(
      (result: ConnectionResult): void => {
        if (!active) return;
        setContext({
          path,
          snapshot: result.ok ? result.data : { status: 'disconnected' },
        });
        if (recentNames[path])
          setRecent((previous: string[]): string[] =>
            [
              path,
              ...previous.filter((item: string): boolean => item !== path),
            ].slice(0, 3),
          );
      },
      (): void => {
        if (active) setContext(null);
      },
    );
    return (): void => {
      active = false;
    };
  }, [location.pathname]);

  return (
    <div className="wiki-theme app-shell" data-wiki-theme={theme}>
      <header className="app-header">
        <Link className="brand" to="/" aria-label="시작">
          <span className="brand-mark" aria-hidden="true">
            <NavigationIcon kind="knowledge" />
          </span>
          <strong>LLM Wiki</strong>
        </Link>
        <span className="header-label">AI Ontology</span>
        <div className="header-context">
          {!settingsPage && (
            <>
              <span className="workspace-name">
                {selected?.tenant || '작업 공간 미선택'}
              </span>
              <Link
                className="profile-link"
                to="/setup/connection"
                aria-label="조회 관점 변경"
              >
                조회 관점{' '}
                <span>
                  {selected?.profile || '선택'}{' '}
                  <span aria-hidden="true">⌄</span>
                </span>
              </Link>
            </>
          )}
          <Link className="connection-link" to="/setup/connection">
            서버 연결
          </Link>
          <IconButton
            aria-label={theme === 'light' ? '어두운 테마' : '밝은 테마'}
            className="theme-toggle"
            onClick={(): void => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              {theme === 'light' ? (
                <path d="M20 14.4A8.5 8.5 0 0 1 9.6 4a8.5 8.5 0 1 0 10.4 10.4Z" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
                </>
              )}
            </svg>
          </IconButton>
        </div>
      </header>
      <aside className="app-sidebar" aria-label="작업 탐색">
        <Button
          className="new-request"
          onClick={(): void => setRequestOpen(true)}
        >
          새 AI 요청
        </Button>
        <div className="sidebar-scroll">
          <nav className="primary-navigation" aria-label="앱 탐색">
            {primaryItems.map((item: NavigationItem): JSX.Element => (
              <Link
                key={item.to}
                to={item.to}
                className={
                  item.routes.includes(location.pathname) ||
                  (questionRunPage && item.icon === 'chat')
                    ? 'active'
                    : undefined
                }
                aria-current={
                  item.routes.includes(location.pathname) ||
                  (questionRunPage && item.icon === 'chat')
                    ? 'page'
                    : undefined
                }
              >
                <NavigationIcon kind={item.icon} />
                {item.label}
              </Link>
            ))}
          </nav>
          <section className="recent-work" aria-label="최근 작업">
            <h2>최근 작업</h2>
            {recent.length ? (
              recent.map((path: string): JSX.Element => (
                <Link
                  key={path}
                  to={path}
                  aria-label={`최근 작업 · ${recentNames[path]}`}
                >
                  {recentNames[path]}
                </Link>
              ))
            ) : (
              <p>아직 연 작업이 없습니다</p>
            )}
          </section>
        </div>
        <nav className="sidebar-bottom" aria-label="작업 공간 메뉴">
          <Link
            to="/history"
            className={location.pathname === '/history' ? 'active' : undefined}
            aria-current={location.pathname === '/history' ? 'page' : undefined}
          >
            <NavigationIcon kind="history" />
            변경 이력
          </Link>
          <Link
            to="/setup/connection"
            className={settingsPage ? 'active' : undefined}
            aria-current={
              location.pathname === '/setup/connection' ? 'page' : undefined
            }
          >
            <NavigationIcon kind="settings" />
            작업 공간
          </Link>
        </nav>
      </aside>
      <main
        id="main-content"
        className={
          workspacePage ? 'app-content app-content--workspace' : 'app-content'
        }
      >
        {children}
      </main>
      <Dialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        title="새 AI 요청"
        description="질문이나 분석에 사용할 자료를 선택하는 단계로 이동합니다."
      >
        <nav className="new-request-options" aria-label="새 요청 종류">
          <Link to="/conversations" onClick={(): void => setRequestOpen(false)}>
            <strong>질문·대화</strong>
            <span>질문과 답변, 사용한 근거를 확인합니다.</span>
          </Link>
          <Link to="/analysis-plan" onClick={(): void => setRequestOpen(false)}>
            <strong>새 분석 요청</strong>
            <span>분석할 자료 범위와 만들 결과를 선택합니다.</span>
          </Link>
          <Link to="/questions" onClick={(): void => setRequestOpen(false)}>
            질문 근거 준비
          </Link>
        </nav>
      </Dialog>
    </div>
  );
}
