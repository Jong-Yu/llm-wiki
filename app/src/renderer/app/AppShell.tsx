import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  FocusEvent,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type {
  ConnectionResult,
  ConnectionSnapshot,
} from '@contracts/connection.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { installUpdate, readUpdateStatus } from '@renderer/platform/update';
import type { UpdateStatus } from '@contracts/update.contract';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { BrandMark } from '@renderer/shared/ui/BrandMark';
import { AiSessionHeader } from '@renderer/features/browse-ai-sessions';
import styles from './AppShell.module.scss';
import { useResolvedTheme } from '@renderer/shared/theme/useThemePreference';
import { useRouteTitles } from '@renderer/shared/lib/routeTitle';
import { HeaderActionsProvider } from '@renderer/shared/lib/headerActions';
import { documentEvidenceReturnTo } from '@renderer/shared/lib/documentEvidence';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import {
  workspaceBreadcrumb,
  workspaceParentLocation,
  workspacePageKey,
} from './workspaceNavigation';
import type { WorkspaceCrumb } from './workspaceNavigation';

type AppShellProps = { children: ReactNode };
type NavigationItem = {
  path: string;
  label: string;
  icon: IconName;
  routes: readonly string[];
};
type ConnectionDisplay =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: ConnectionSnapshot }
  | { status: 'error' };

const navigation: readonly NavigationItem[] = [
  {
    path: '/documents',
    label: '문서',
    icon: 'files',
    routes: [
      '/documents',
      '/register',
      '/document',
      '/source',
      '/jobs',
      '/analysis-proposals',
    ],
  },
  {
    path: '/ontology',
    label: '온톨로지',
    icon: 'network',
    routes: ['/ontology'],
  },
  {
    path: '/review',
    label: '검토함',
    icon: 'clipboard-check',
    routes: ['/review'],
  },
  {
    path: '/chat',
    label: 'AI 채팅',
    icon: 'message-square',
    routes: ['/chat', '/artifact'],
  },
  {
    path: '/sessions',
    label: 'AI 세션',
    icon: 'bot',
    routes: ['/sessions', '/sessions/history'],
  },
];

const pageTitles: Readonly<Record<string, string>> = {
  '/documents': '문서',
  '/register': '문서 등록',
  '/document': '문서 상세',
  '/source': '등록 원본 상세',
  '/review': '검토함',
  '/ontology': '온톨로지',
  '/chat': 'AI 채팅',
  '/artifact': '산출물',
  '/analysis-proposals': '관계 추출 결과 비교',
  '/sessions': 'AI 세션',
  '/sessions/history': '지난 기록',
  '/jobs': '분석 작업',
  '/settings': '연결 설정',
  '/guide': '사용자 가이드',
};

/** 하위 영역이 여럿이라 헤더·본문 영역을 각각 별도 패널로 나누는 화면입니다. */
const splitPanelRoutes: readonly string[] = ['/review', '/ontology'];

/** 공개 연결 상태만 관찰하며 화면의 권한·자료 조회는 각 feature에 맡깁니다. */
function useConnectionDisplay(path: string): ConnectionDisplay {
  const [display, setDisplay] = useState<ConnectionDisplay>({
    status: 'loading',
  });
  const unreachable =
    display.status === 'ready' &&
    display.snapshot.status === 'connected' &&
    display.snapshot.serverUnreachable === true;
  // 끊김 안내가 떠 있는 동안에는 다른 화면의 요청이 성공해 안내가 풀리는지 주기적으로 다시 읽습니다.
  useEffect((): (() => void) | void => {
    if (!unreachable) return;
    const poll = window.setInterval((): void => {
      window.dispatchEvent(new Event('wiki-connection-changed'));
    }, 8000);
    return (): void => window.clearInterval(poll);
  }, [unreachable]);

  useEffect((): (() => void) => {
    let active = true;
    let pending = false;

    /** 중복 요청과 이전 경로의 늦은 응답이 현재 연결 표시를 덮지 않게 합니다. */
    const refresh = (): void => {
      if (!active || pending || document.visibilityState === 'hidden') return;
      pending = true;
      void connectionGateway
        .getState()
        .then(
          (result: ConnectionResult): void => {
            if (active)
              setDisplay(
                result.ok
                  ? { status: 'ready', snapshot: result.data }
                  : { status: 'error' },
              );
          },
          (): void => {
            if (active) setDisplay({ status: 'error' });
          },
        )
        .finally((): void => {
          pending = false;
        });
    };

    refresh();
    // getState는 네트워크 요청 없이 main의 공개 snapshot을 읽습니다.
    // 실제 권한 재확인은 각 feature의 자료 요청이 담당합니다.
    window.addEventListener('focus', refresh);
    window.addEventListener('wiki-connection-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    return (): void => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('wiki-connection-changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [path]);

  return display;
}

/** Header 오른쪽 버튼 자리 요소를 만듭니다. */
function createActionsNode(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}
/** 좁은 폭의 메뉴 열림 상태를 자리 요소에 표시합니다. */
function setActionsOpenFlag(node: HTMLDivElement, open: boolean): void {
  node.dataset.open = String(open);
}
/** 새 화면의 탐색·테마·현재 연결 표시만 조립하는 공통 앱 프레임입니다. */
export function AppShell({ children }: AppShellProps): JSX.Element {
  const location = useLocation();
  const content = useRef<HTMLDivElement>(null);
  // 화면이 Header 오른쪽에 놓는 버튼의 자리와, 좁은 폭에서 그 버튼을 접는 메뉴 상태입니다.
  // 첫 그림부터 쓸 수 있도록 자리 요소를 미리 만들고, Header가 그려질 때 붙입니다.
  const [actionsNode] = useState<HTMLDivElement>((): HTMLDivElement =>
    createActionsNode(styles.topbarActions),
  );
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect((): (() => void) => {
    setActionsOpenFlag(actionsNode, actionsOpen);
    const close = (): void => setActionsOpen(false);
    actionsNode.addEventListener('click', close);
    return (): void => actionsNode.removeEventListener('click', close);
  }, [actionsNode, actionsOpen]);
  const explorerToggle = useRef<HTMLButtonElement>(null);
  const menuClose = useRef<HTMLButtonElement>(null);
  const pageKey = workspacePageKey(location.pathname, location.search);
  const routeTitles = useRouteTitles();
  // 문서·원본 상세는 화면이 알려 준 제목을 탭 제목에도 씁니다.
  const detailTitle =
    location.pathname === '/document' || location.pathname === '/source'
      ? (workspaceBreadcrumb(
          location.pathname,
          location.search,
          (key: string): string | undefined => routeTitles.get(key),
        ).at(-1)?.label ?? null)
      : null;
  const previousDestination = useRef({
    pathname: location.pathname,
    pageKey,
  });
  // 화면을 숨기며 잃은 초점만 복구하고 탭·필터·입력 중의 초점은 유지합니다.
  useLayoutEffect((): void => {
    const previous = previousDestination.current;
    previousDestination.current = { pathname: location.pathname, pageKey };
    document.title = `${detailTitle ?? pageTitles[location.pathname] ?? '화면을 찾을 수 없음'} · LLM Wiki`;
    if (previous.pathname === location.pathname && previous.pageKey === pageKey)
      return;
    const focused = document.activeElement;
    if (
      focused === document.body ||
      (focused instanceof HTMLElement &&
        focused.closest('[data-workspace-route][hidden]'))
    )
      content.current?.focus({ preventScroll: true });
  }, [location.pathname, pageKey, detailTitle]);
  useEffect((): (() => void) => {
    return (): void => {
      document.title = 'LLM Wiki';
    };
  }, []);
  const theme = useResolvedTheme();
  // 대화상자 등 앱 틀 밖에 그려지는 요소도 같은 테마 토큰을 쓰도록 문서 루트에 표시합니다.
  useEffect((): (() => void) => {
    document.documentElement.dataset.wikiTheme = theme;
    return (): void => {
      delete document.documentElement.dataset.wikiTheme;
    };
  }, [theme]);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(
    (): boolean => window.matchMedia('(min-width: 900px)').matches,
  );
  useEffect((): (() => void) => {
    const media = window.matchMedia('(min-width: 900px)');
    const resize = (event: MediaQueryListEvent): void =>
      setSidebarOpen(event.matches);
    media.addEventListener('change', resize);
    return (): void => media.removeEventListener('change', resize);
  }, []);
  // 겹쳐 열린 메뉴 뒤에 키보드 초점이 남지 않도록 보이는 닫기 버튼으로 옮깁니다.
  useEffect((): void => {
    if (sidebarOpen && !window.matchMedia('(min-width: 900px)').matches)
      menuClose.current?.focus();
  }, [sidebarOpen]);
  // 접힌 사이드바에 마우스·키보드 초점이 닿으면 본문을 밀지 않는 임시 오버레이로 펼칩니다.
  const [hoverRequested, setHoverRequested] = useState<boolean>(false);
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' });
  const [installing, setInstalling] = useState<boolean>(false);
  // 내려받기가 끝나면 설정 위에 업데이트 항목을 보여 주기 위해 주기적으로 상태를 읽습니다.
  useEffect((): (() => void) => {
    let active = true;
    const refresh = (): void => {
      void readUpdateStatus()
        .then((next: UpdateStatus): void => {
          if (active) setUpdate(next);
        })
        .catch((): void => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return (): void => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  // 고정으로 펼친 상태에서는 임시 펼침을 쓰지 않습니다.
  const hoverOpen = hoverRequested && !sidebarOpen;
  const hoverTimer = useRef<number | null>(null);
  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect((): (() => void) => clearHoverTimer, []);
  /** 우연한 통과로 펼쳐지지 않도록 지연 후 펼칩니다. 초점은 즉시 펼칩니다. */
  const requestHoverOpen = (delay: number): void => {
    if (sidebarOpen || !window.matchMedia('(min-width: 900px)').matches) return;
    clearHoverTimer();
    if (delay === 0) setHoverRequested(true);
    else
      hoverTimer.current = window.setTimeout((): void => {
        setHoverRequested(true);
      }, delay);
  };
  const closeHoverOpen = (): void => {
    clearHoverTimer();
    setHoverRequested(false);
  };
  const splitPanels = splitPanelRoutes.includes(location.pathname);
  const connection = useConnectionDisplay(location.pathname);
  const snapshot = connection.status === 'ready' ? connection.snapshot : null;
  const connected = snapshot?.status === 'connected';
  const selection =
    snapshot?.status === 'connected' ? snapshot.selection : null;
  const workspaceName =
    snapshot?.status === 'connected'
      ? (snapshot.workspaces.find(
          (workspace: (typeof snapshot.workspaces)[number]): boolean =>
            workspace.id === selection?.tenant,
        )?.displayName ?? '작업 공간')
      : undefined;
  const connectionLabel =
    connection.status === 'loading'
      ? '연결 확인 중'
      : connection.status === 'error'
        ? '연결 상태 확인 실패'
        : connected
          ? '연결됨'
          : '연결되지 않음';

  /** 작은 창에서 목적지를 열면 본문을 가리고 있던 탐색기를 접습니다. */
  const openDestination = (): void => {
    if (!window.matchMedia('(min-width: 900px)').matches) setSidebarOpen(false);
  };

  const breadcrumb = workspaceBreadcrumb(
    location.pathname,
    location.search,
    (key: string): string | undefined => routeTitles.get(key),
  );
  const navigate = useNavigate();
  const [switching, setSwitching] = useState<boolean>(false);
  /** 하위 화면에서만 뒤로가기를 보입니다. 맨 위 메뉴 화면은 돌아갈 곳이 없습니다. */
  const canGoUp = breadcrumb.length > 1;
  /** 근거 문서는 검증된 탐색 위치로, 나머지는 주소 기록과 무관하게 위치 경로의 위 단계로 돌아갑니다. */
  const goBack = (): void => {
    const returnTo =
      location.pathname === '/document'
        ? documentEvidenceReturnTo(location.state)
        : null;
    if (returnTo) {
      void navigate(returnTo);
      return;
    }
    const parent: WorkspaceCrumb | undefined =
      breadcrumb[breadcrumb.length - 2];
    void navigate(
      parent?.to ?? workspaceParentLocation(location.pathname, location.search),
    );
  };

  return (
    <div
      className={`wiki-theme ${styles.appShell}`}
      data-wiki-theme={theme}
      data-sidebar-open={sidebarOpen}
      data-sidebar-hover={hoverOpen}
      data-panels-split={splitPanels}
    >
      <a
        className={styles.skipLink}
        href="#app-content"
        onClick={(event: MouseEvent<HTMLAnchorElement>): void => {
          event.preventDefault();
          openDestination();
          content.current?.focus();
        }}
      >
        본문으로 이동
      </a>
      <aside
        id="workspace-navigation"
        className={styles.sidebar}
        aria-label="작업 공간 메뉴"
        onMouseEnter={(): void => requestHoverOpen(200)}
        onMouseLeave={closeHoverOpen}
        onFocus={(event: FocusEvent<HTMLElement>): void => {
          if (event.target.matches(':focus-visible')) requestHoverOpen(0);
        }}
        onBlur={(event: FocusEvent<HTMLElement>): void => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            closeHoverOpen();
            openDestination();
          }
        }}
        onKeyDown={(event: KeyboardEvent<HTMLElement>): void => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeHoverOpen();
            setSidebarOpen(false);
            explorerToggle.current?.focus();
          }
        }}
      >
        <div className={styles.brandRow}>
          <Link
            to="/documents"
            className={styles.brand}
            aria-label="LLM Wiki 문서"
            onClick={openDestination}
          >
            <BrandMark />
            <span className={styles.navigationText}>LLM Wiki</span>
          </Link>
          <button
            type="button"
            className={styles.sidebarToggle}
            aria-label={sidebarOpen ? '메뉴 접기' : '메뉴 펼치기'}
            title={sidebarOpen ? '메뉴 접기' : '메뉴 펼치기'}
            aria-expanded={sidebarOpen}
            ref={explorerToggle}
            aria-controls="workspace-navigation"
            onClick={(): void => {
              closeHoverOpen();
              setSidebarOpen(!sidebarOpen);
            }}
          >
            <Icon name="panel-left" size={18} />
          </button>
          <button
            type="button"
            className={styles.mobileClose}
            ref={menuClose}
            aria-label="메뉴 닫기"
            onClick={(): void => {
              setSidebarOpen(false);
              explorerToggle.current?.focus();
            }}
          >
            <Icon name="x" />
          </button>
        </div>
        {snapshot?.status === 'connected' ? (
          <WorkspaceSwitcher
            connectionId={snapshot.connectionId}
            workspaces={snapshot.workspaces}
            currentId={selection?.tenant ?? null}
            onNavigate={(): void => {
              openDestination();
              void navigate('/documents');
            }}
            onSwitchingChange={setSwitching}
          />
        ) : (
          <Link
            to="/settings"
            className={styles.workspace}
            aria-label="작업 공간 선택 · 설정"
            title="작업 공간 설정"
            onClick={openDestination}
          >
            <Icon name="folder-open" />
            <span className={styles.navigationText}>작업 공간 선택</span>
            <Icon name="chevron-right" className={styles.workspaceArrow} />
          </Link>
        )}
        <nav className={styles.navigation} aria-label="기본 메뉴">
          {navigation.map((item: NavigationItem): JSX.Element => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              title={!sidebarOpen && !hoverOpen ? item.label : undefined}
              aria-current={
                item.routes.includes(location.pathname) ? 'page' : undefined
              }
              onClick={openDestination}
            >
              <Icon name={item.icon} size={18} />
              <span className={styles.navigationText}>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className={styles.sidebarBottom}>
          <Link
            to="/guide"
            className={styles.settingsLink}
            aria-label="사용자 가이드"
            title="사용자 가이드"
            aria-current={location.pathname === '/guide' ? 'page' : undefined}
            onClick={openDestination}
          >
            <Icon name="circle-help" size={18} />
            <span className={styles.navigationText}>사용자 가이드</span>
          </Link>
          {update.state === 'ready' && (
            <button
              type="button"
              className={`${styles.settingsLink} ${styles.updateButton}`}
              aria-label={`새 버전 ${update.version ?? ''} 업데이트 후 재시작`}
              title="업데이트하고 재시작"
              disabled={installing}
              onClick={(): void => {
                setInstalling(true);
                void installUpdate().catch((): void => setInstalling(false));
              }}
            >
              <Icon name="download" size={18} />
              <span className={styles.navigationText}>
                {installing ? '업데이트 중' : '업데이트'}
              </span>
            </button>
          )}
          <Link
            to="/settings"
            className={styles.settingsLink}
            aria-label="설정"
            title="설정"
            aria-current={
              location.pathname === '/settings' ? 'page' : undefined
            }
            onClick={openDestination}
          >
            <Icon name="settings" size={18} />
            <span className={styles.navigationText}>설정</span>
          </Link>
        </div>
      </aside>
      <div className={styles.main}>
        <header className={styles.topbar}>
          {canGoUp && (
            <button
              type="button"
              className={styles.backButton}
              aria-label="뒤로가기"
              title="뒤로가기"
              onClick={goBack}
            >
              <Icon name="arrow-left" size={18} />
            </button>
          )}
          {breadcrumb.length > 0 && (
            <nav className={styles.breadcrumb} aria-label="현재 위치">
              <ol>
                {breadcrumb.map(
                  (crumb: WorkspaceCrumb, index: number): JSX.Element => {
                    const last = index === breadcrumb.length - 1;
                    return (
                      <li key={`${index}:${crumb.label}`}>
                        {index > 0 && (
                          <span
                            className={styles.crumbSeparator}
                            aria-hidden="true"
                          >
                            ›
                          </span>
                        )}
                        {crumb.to && !last ? (
                          <Link to={crumb.to} onClick={openDestination}>
                            {crumb.label}
                          </Link>
                        ) : last ? (
                          <h1
                            className={styles.crumbCurrent}
                            aria-current="page"
                          >
                            {crumb.label}
                          </h1>
                        ) : (
                          <span>{crumb.label}</span>
                        )}
                      </li>
                    );
                  },
                )}
              </ol>
            </nav>
          )}
          <div
            className={styles.topbarActionsSlot}
            ref={(host: HTMLDivElement | null): void => {
              if (host && !host.contains(actionsNode))
                host.replaceChildren(actionsNode);
            }}
          />
          <button
            type="button"
            className={styles.actionsToggle}
            aria-label="화면 메뉴"
            title="화면 메뉴"
            aria-expanded={actionsOpen}
            onClick={(): void =>
              setActionsOpen((open: boolean): boolean => !open)
            }
          >
            <Icon name="ellipsis" size={18} />
          </button>
        </header>
        <div
          role={location.pathname === '/register' ? undefined : 'main'}
          id="app-content"
          ref={content}
          className={styles.content}
          data-workspace-container
          tabIndex={-1}
        >
          {snapshot?.status === 'connected' && snapshot.serverUnreachable && (
            <ConnectionNotice kind="server-disconnected" />
          )}
          {switching && (
            <StatusNotice tone="info" title="작업 공간을 바꾸는 중" />
          )}
          {/* 전환이 실패해도 입력 중인 화면이 사라지지 않도록 숨기기만 합니다. */}
          <div hidden={switching} className={styles.contentInner}>
            <HeaderActionsProvider node={actionsNode}>
              {children}
            </HeaderActionsProvider>
          </div>
        </div>
      </div>
      <footer className={styles.statusbar} aria-label="작업 공간 상태">
        <Link to="/settings" className={styles.connection}>
          <span
            className={connected ? styles.connectedDot : styles.disconnectedDot}
            aria-hidden="true"
          />
          <span>{connectionLabel}</span>
        </Link>
        <span className={styles.statusWorkspace}>
          {workspaceName || 'LLM Wiki'}
        </span>
        <div className={styles.sessionStatus}>
          <AiSessionHeader
            connectionId={
              snapshot?.status === 'connected' ? snapshot.connectionId : null
            }
          />
        </div>
      </footer>
    </div>
  );
}
