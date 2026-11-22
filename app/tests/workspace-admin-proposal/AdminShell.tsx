import { useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { UsersRound } from 'lucide-react';
import { BrandMark } from '@renderer/shared/ui/BrandMark';
import { Icon } from '@renderer/shared/ui/Icon';
import { useResolvedTheme } from '@renderer/shared/theme/useThemePreference';
import shell from '@renderer/app/AppShell.module.scss';
import styles from './Proposal.module.scss';
import { IconAction } from './controls';
export type Crumb = { label: string; to?: string };
type AdminShellProps = {
  crumbs: Crumb[];
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  onNavigate: (path: string) => void;
  onCrumbNavigate: (path: string) => void;
  onExit: () => void;
  serverUrl: string;
};
/** 실제 AppShell의 셸·헤더·탐색·본문 클래스를 관리 전용 내용으로 재사용합니다. */
export function AdminShell({
  crumbs,
  onBack,
  actions,
  children,
  onNavigate,
  onCrumbNavigate,
  onExit,
  serverUrl,
}: AdminShellProps): JSX.Element {
  const location = useLocation();
  const theme = useResolvedTheme();
  const [expanded, setExpanded] = useState(
    (): boolean => window.matchMedia('(min-width:900px)').matches,
  );
  const content = useRef<HTMLDivElement>(null);
  useEffect((): void => {
    if (
      document.activeElement === document.body ||
      !document.activeElement?.isConnected
    )
      content.current?.focus({ preventScroll: true });
  }, [location.pathname, location.search]);
  useEffect((): (() => void) => {
    const mq = window.matchMedia('(min-width:900px)');
    const resize = (event: MediaQueryListEvent): void =>
      setExpanded(event.matches);
    mq.addEventListener('change', resize);
    return (): void => mq.removeEventListener('change', resize);
  }, []);
  const base =
    location.pathname === '/admin/users' ||
    location.pathname === '/admin/user' ||
    (location.pathname === '/admin/assign' &&
      new URLSearchParams(location.search).has('user')) ||
    (location.pathname === '/admin/history/filter' &&
      new URLSearchParams(location.search).get('scope')?.startsWith('user:')) ||
    new URLSearchParams(location.search).get('origin') === 'user'
      ? '/admin/users'
      : '/admin/workspaces';
  return (
    <div
      className={`wiki-theme ${shell.appShell} ${styles.previewShell}`}
      data-wiki-theme={theme}
      data-sidebar-open={expanded}
      data-sidebar-hover="false"
      data-panels-split="false"
    >
      <aside className={shell.sidebar} aria-label="서버 관리 메뉴">
        <div className={shell.brandRow}>
          <Link
            to="/admin/workspaces"
            className={shell.brand}
            aria-label="LLM Wiki 관리 콘솔"
            onClick={(event: MouseEvent<HTMLAnchorElement>): void => {
              event.preventDefault();
              onNavigate('/admin/workspaces');
            }}
          >
            <BrandMark />
            <span className={shell.navigationText}>LLM Wiki</span>
          </Link>
          <button
            type="button"
            className={shell.sidebarToggle}
            aria-label={expanded ? '메뉴 접기' : '메뉴 펼치기'}
            aria-expanded={expanded}
            onClick={(): void => setExpanded(!expanded)}
          >
            <Icon name="panel-left" size={18} />
          </button>
          <button
            type="button"
            className={shell.mobileClose}
            aria-label="메뉴 닫기"
            onClick={(): void => setExpanded(false)}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className={shell.workspace} aria-label="관리 콘솔">
          <Icon name="settings" />
          <span className={shell.navigationText}>관리 콘솔</span>
        </div>
        <nav className={shell.navigation} aria-label="관리 탐색">
          {[
            { path: '/admin/workspaces', label: '워크스페이스' },
            { path: '/admin/users', label: '사용자' },
          ].map((item): JSX.Element => (
            <Link
              key={item.path}
              to={item.path}
              aria-label={item.label}
              title={!expanded ? item.label : undefined}
              aria-current={base === item.path ? 'page' : undefined}
              onClick={(event: MouseEvent<HTMLAnchorElement>): void => {
                event.preventDefault();
                onNavigate(item.path);
                if (!window.matchMedia('(min-width:900px)').matches)
                  setExpanded(false);
              }}
            >
              {item.path.includes('users') ? (
                <UsersRound size={18} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Icon name="folder-open" size={18} />
              )}
              <span className={shell.navigationText}>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className={shell.sidebarBottom}>
          <div className={shell.settingsLink} aria-label="서버 운영자 · 관리자">
            <UsersRound size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className={shell.navigationText}>서버 운영자</span>
          </div>
          <button
            type="button"
            className={shell.settingsLink}
            aria-label="관리 종료"
            onClick={onExit}
          >
            <Icon name="log-out" size={18} />
            <span className={shell.navigationText}>관리 종료</span>
          </button>
        </div>
      </aside>
      <div className={shell.main}>
        <header className={shell.topbar}>
          {onBack && (
            <IconAction label="뒤로가기" icon="arrow-left" onClick={onBack} />
          )}
          <nav className={shell.breadcrumb} aria-label="현재 위치">
            <ol>
              {crumbs.map((crumb: Crumb, index: number): JSX.Element => (
                <li key={`${index}-${crumb.label}`}>
                  {index > 0 && (
                    <span className={shell.crumbSeparator} aria-hidden="true">
                      ›
                    </span>
                  )}
                  {crumb.to ? (
                    <Link
                      to={crumb.to}
                      onClick={(event: MouseEvent<HTMLAnchorElement>): void => {
                        event.preventDefault();
                        if (crumb.to) onCrumbNavigate(crumb.to);
                      }}
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <h1 className={shell.crumbCurrent} aria-current="page">
                      {crumb.label}
                    </h1>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className={`${shell.topbarActions} ${styles.headerActions}`}>
            {actions}
          </div>
        </header>
        <div
          id="admin-content"
          role="main"
          tabIndex={-1}
          ref={content}
          className={shell.content}
          data-workspace-container
        >
          <div className={shell.contentInner}>{children}</div>
        </div>
      </div>
      <footer className={shell.statusbar} aria-label="관리 서버">
        <span className={shell.connection}>
          <span className={shell.connectedDot} aria-hidden="true" />
          {new URL(serverUrl).host}
        </span>
        <span className={shell.statusWorkspace}>서버 관리</span>
      </footer>
    </div>
  );
}
