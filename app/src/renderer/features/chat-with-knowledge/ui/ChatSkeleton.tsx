import type { JSX } from 'react';
import {
  SkeletonBar,
  SkeletonList,
  SkeletonText,
} from '@renderer/shared/ui/Skeleton';
import { AssistantMessage } from './AssistantMessage';
import styles from './KnowledgeChat.module.scss';

/** 실제 질문 말풍선과 AI 답변의 들여쓰기·읽기 폭으로 대화를 기다립니다. */
export function ChatSkeleton(): JSX.Element {
  return (
    <SkeletonList label="대화를 불러오는 중" className={styles.chatSkeleton}>
      <div
        className={`${styles.user} ${styles.skeletonUser}`}
        aria-hidden="true"
      >
        <p className={styles.skeletonQuestion}>
          <SkeletonBar shape="bar" />
        </p>
      </div>
      <div aria-hidden="true">
        <AssistantMessage>
          <SkeletonBar shape="badge" className={styles.skeletonScope} />
          <SkeletonText lines={4} />
          <div className={styles.skeletonParagraph}>
            <SkeletonText lines={3} />
          </div>
        </AssistantMessage>
      </div>
    </SkeletonList>
  );
}
