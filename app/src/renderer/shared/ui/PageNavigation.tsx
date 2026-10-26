import type { JSX } from 'react';
import { Link } from 'react-router';
import styles from './PageNavigation.module.scss';

export type PageLink = { to: string; label: string };
type PageNavigationProps = { links: readonly PageLink[] };
/** 관련 기능의 진입점을 해당 작업의 도구 모음 안에 표시합니다. */
export function PageNavigation({ links }: PageNavigationProps): JSX.Element {
  return (
    <nav className={styles.links} aria-label="관련 작업">
      {links.map((link: PageLink): JSX.Element => (
        <Link key={link.to} to={link.to}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
