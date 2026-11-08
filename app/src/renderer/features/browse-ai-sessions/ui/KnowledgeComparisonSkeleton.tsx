import type { JSX } from 'react';
import { SkeletonBar, SkeletonList } from '@renderer/shared/ui/Skeleton';
import styles from './AiSessions.module.scss';

type KnowledgeComparisonSkeletonProps = { showPicker?: boolean };

/** 대조 결과의 실행 선택과 접힌 결과 요약 자리를 유지합니다. */
export function KnowledgeComparisonSkeleton({
  showPicker = true,
}: KnowledgeComparisonSkeletonProps): JSX.Element {
  return (
    <SkeletonList
      label="대조 상태를 불러오는 중"
      className={styles.comparisonSkeleton}
    >
      {showPicker && (
        <div className={styles.recordPicker} aria-hidden="true">
          실행 기록 <SkeletonBar shape="badge" />
        </div>
      )}
      <div className={styles.comparisonResult} aria-hidden="true">
        <div className={styles.skeletonSummary}>
          <SkeletonBar shape="title" />
          <SkeletonBar shape="badge" />
        </div>
      </div>
    </SkeletonList>
  );
}
