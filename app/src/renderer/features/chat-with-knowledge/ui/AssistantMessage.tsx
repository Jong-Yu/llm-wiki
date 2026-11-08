import type { JSX, ReactNode } from 'react';
import styles from './KnowledgeChat.module.scss';

type AssistantMessageProps = { children: ReactNode; saved?: boolean };
/** 저장된 답변만 article로 구분하며 진행·실패에도 같은 아이콘과 정렬을 씁니다. */
export function AssistantMessage({
  children,
  saved = false,
}: AssistantMessageProps): JSX.Element {
  const Element = saved ? 'article' : 'div';
  return (
    <Element className={styles.assistant}>
      <span className={styles.avatar} aria-hidden="true">
        AI
      </span>
      <div className={styles.answer}>
        {saved && <span className={styles.srOnly}>답변</span>}
        {children}
      </div>
    </Element>
  );
}
