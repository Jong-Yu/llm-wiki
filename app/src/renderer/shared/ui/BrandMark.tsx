import type { JSX } from 'react';
import styles from './BrandMark.module.scss';

type BrandMarkProps = { className?: string };

/** 같은 투명 로고에서 주황 점은 유지하고 중립색만 화면 테마에 맞춥니다. */
export function BrandMark({ className = '' }: BrandMarkProps): JSX.Element {
  return <span className={`${styles.mark} ${className}`} aria-hidden="true" />;
}
