import { useId } from 'react';
import type { JSX, ReactNode } from 'react';
import styles from './WorkspaceSection.module.scss';

type WorkspaceSectionProps = {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3 | 4;
  id?: string;
};

/** 함께 읽는 정보와 행동을 배경 없는 제목과 얇은 구분선으로 묶습니다. */
export function WorkspaceSection({
  title,
  children,
  actions,
  className,
  headingLevel = 2,
  id,
}: WorkspaceSectionProps): JSX.Element {
  const titleId = useId();
  const Heading = headingLevel === 4 ? 'h4' : headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section
      id={id}
      className={[styles.root, className].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      data-workspace-section
    >
      <header className={styles.header}>
        <Heading id={titleId} className={styles.title}>
          {title}
        </Heading>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
