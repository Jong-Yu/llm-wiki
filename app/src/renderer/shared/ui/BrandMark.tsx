import type { JSX } from 'react';
import styles from './BrandMark.module.scss';

type BrandMarkProps = { className?: string };

/** 제품명 옆에 같은 책장 심볼을 현재 화면 테마의 색으로 표시합니다. */
export function BrandMark({ className = '' }: BrandMarkProps): JSX.Element {
  return <span className={`${styles.mark} ${className}`} aria-hidden="true" />;
}
