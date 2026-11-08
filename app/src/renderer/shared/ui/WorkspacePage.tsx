import type { JSX, ReactNode } from 'react';
import { HeaderActions } from '../lib/headerActions';
import { Button } from './Button';
import styles from './WorkspacePage.module.scss';

type WorkspacePageProps = {
  title: string;
  children: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
  hidden?: boolean;
  standalone?: boolean;
};

/** 업무 작업을 배경 차단 없는 본문으로 표시하고 숨긴 초안의 컴포넌트 수명을 유지합니다. */
/**
 * 업무 작업을 배경 차단 없는 본문으로 표시하고 숨긴 초안의 컴포넌트 수명을 유지합니다.
 * 화면 제목은 앱 Header가 보이고(덧씌움 화면 제외), 주 행동(최대 3개)은 Header 오른쪽에 놓입니다.
 */
export function WorkspacePage({
  title,
  children,
  onBack,
  backLabel = '이전 화면으로',
  actions,
  className,
  hidden = false,
  standalone = false,
}: WorkspacePageProps): JSX.Element {
  return (
    <section
      hidden={hidden}
      className={[styles.root, className].filter(Boolean).join(' ')}
      aria-label={title}
      data-workspace-page
      data-standalone={standalone || undefined}
    >
      {actions && <HeaderActions>{actions}</HeaderActions>}
      {(onBack || standalone) && (
        // 앱 Header에 제목이 없는 덧씌움·단독 화면은 자기 제목(과 돌아가기)을 보입니다.
        <div className={styles.heading}>
          {onBack && (
            <Button variant="secondary" onClick={onBack}>
              {backLabel}
            </Button>
          )}
          <h2>{title}</h2>
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
