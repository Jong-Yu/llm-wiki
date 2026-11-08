import type { JSX, ReactNode } from 'react';
import styles from './Skeleton.module.scss';

export type SkeletonShape =
  | 'icon'
  | 'title'
  | 'sub'
  | 'badge'
  | 'bar'
  | 'heading'
  | 'line';
type SkeletonBarProps = {
  shape: SkeletonShape;
  className?: string;
};
/** 모양별 크기가 정해진 한 조각의 자리표시자입니다. 목록·상세 스켈레톤이 같은 조각을 씁니다. */
export function SkeletonBar({
  shape,
  className,
}: SkeletonBarProps): JSX.Element {
  return (
    <span
      className={[styles.bar, className].filter(Boolean).join(' ')}
      data-shape={shape}
      aria-hidden="true"
    />
  );
}

type SkeletonTextProps = { lines?: number; className?: string };
/** 본문 줄 간격과 짧은 문단 끝을 표현하며 바깥 배치는 화면이 소유합니다. */
export function SkeletonText({
  lines = 3,
  className,
}: SkeletonTextProps): JSX.Element {
  return (
    <div
      className={[styles.text, className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      {Array.from(
        { length: lines },
        (_: unknown, index: number): JSX.Element => (
          <SkeletonBar key={index} shape="bar" />
        ),
      )}
    </div>
  );
}

type SkeletonListProps = {
  label: string;
  className?: string;
  children: ReactNode;
};
/** 조각들을 세로로 쌓고 스크린 리더에 불러오는 대상을 알립니다. */
export function SkeletonList({
  label,
  className,
  children,
}: SkeletonListProps): JSX.Element {
  return (
    <div
      className={[styles.list, className].filter(Boolean).join(' ')}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {children}
    </div>
  );
}
