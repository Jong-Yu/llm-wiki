import type { JSX } from 'react';
import {
  SkeletonBar,
  SkeletonList,
  SkeletonText,
} from '@renderer/shared/ui/Skeleton';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { KnowledgeComparisonSkeleton } from './KnowledgeComparisonSkeleton';
import styles from './AiSessions.module.scss';

/** 작업 상세의 현재 상태·저장 결과·접힌 기록·대조 결과 배치를 먼저 확보합니다. */
export function AnalysisJobSkeleton(): JSX.Element {
  return (
    <>
      <WorkspaceSection title="현재 작업">
        <SkeletonList
          label="작업 상태를 불러오는 중"
          className={styles.jobSkeleton}
        >
          <div className={styles.jobSummary} aria-hidden="true">
            <div>
              <h3 className={styles.jobStatus}>
                <SkeletonBar shape="badge" />
              </h3>
              <p>
                <SkeletonBar shape="bar" />
              </p>
            </div>
            <div className={styles.actions}>
              <SkeletonBar shape="badge" />
              <SkeletonBar shape="badge" />
            </div>
          </div>
          <div className={styles.factChips} aria-hidden="true">
            <SkeletonBar shape="badge" />
            <SkeletonBar shape="badge" />
            <SkeletonBar shape="badge" />
          </div>
        </SkeletonList>
      </WorkspaceSection>
      <WorkspaceSection title="저장 결과">
        <SkeletonList
          label="저장 결과를 불러오는 중"
          className={styles.jobSkeleton}
        >
          <SkeletonText lines={3} />
        </SkeletonList>
      </WorkspaceSection>
      <div className={styles.record} aria-hidden="true">
        <SkeletonBar shape="badge" />
      </div>
      <WorkspaceSection
        title="기존 지식 대조"
        actions={
          <SkeletonBar shape="badge" className={styles.skeletonAction} />
        }
      >
        <KnowledgeComparisonSkeleton />
      </WorkspaceSection>
    </>
  );
}
