import type { JSX } from 'react';
import { SkeletonBar, SkeletonList } from '@renderer/shared/ui/Skeleton';
import styles from './AiSessions.module.scss';

type SessionSkeletonProps = {
  /** 스크린 리더에 알릴 불러오는 대상 설명. */
  label?: string;
  rows?: number;
};

/** 현재 작업 목록과 같은 세 열·행 높이·반응형 배치를 유지합니다. */
export function SessionSkeleton({
  label = '세션을 불러오는 중',
  rows = 3,
}: SessionSkeletonProps): JSX.Element {
  return (
    <SkeletonList label={label} className={styles.sessionSkeleton}>
      <div className={styles.skeletonHeading}>
        <SkeletonBar shape="badge" />
      </div>
      <ul className={styles.list} aria-hidden="true">
        {Array.from(
          { length: rows },
          (_: unknown, index: number): JSX.Element => (
            <li key={index}>
              <div>
                <h3>
                  <SkeletonBar shape="badge" />
                  <SkeletonBar shape="title" />
                </h3>
                <SkeletonBar shape="sub" />
              </div>
              <span className={styles.rowState}>
                <SkeletonBar shape="badge" />
              </span>
              <div className={styles.rowActions}>
                <SkeletonBar shape="badge" />
                <SkeletonBar shape="badge" />
              </div>
            </li>
          ),
        )}
      </ul>
    </SkeletonList>
  );
}
