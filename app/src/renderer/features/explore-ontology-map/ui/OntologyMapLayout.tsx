import type { JSX, ReactNode } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './OntologyMapLayout.module.scss';

export type OntologyMapLayoutProps = {
  header: ReactNode;
  /** 문서 범위로 열었는지: 아니면 개념 목록 버튼이 필요한 좁은 폭에서만 머리글 띠를 보입니다. */
  scoped: boolean;
  index: ReactNode;
  children: ReactNode;
  details: ReactNode;
  detailsLabel: string;
  closeLabel: string;
  detailsOpen: boolean;
  /** 참이면 상세를 지도 위에 겹쳐 열어 지도 폭을 유지합니다. */
  overlayDetails: boolean;
  indexOpen: boolean;
  onCloseDetails: () => void;
};

/**
 * 개념 목록·헤더·그래프(·상세)를 8px 간격의 독립 패널로 나눕니다.
 * 목록은 넓은 화면에서 항상 보이고, 좁아지면 헤더의 열기 버튼으로 전환합니다(CSS 컨테이너 쿼리).
 */
export function OntologyMapLayout({
  header,
  scoped,
  index,
  children,
  details,
  detailsLabel,
  closeLabel,
  detailsOpen,
  overlayDetails,
  indexOpen,
  onCloseDetails,
}: OntologyMapLayoutProps): JSX.Element {
  return (
    <div
      className={styles.layout}
      data-details-open={detailsOpen}
      data-overlay={overlayDetails}
      data-index-open={indexOpen}
    >
      <section
        className={`${styles.panel} ${styles.index}`}
        aria-label="개념 목록"
        data-pane="index"
      >
        {index}
      </section>
      <div className={styles.center}>
        <header
          className={`${styles.panel} ${styles.header}`}
          data-scoped={scoped}
        >
          {header}
        </header>
        <section
          className={`${styles.panel} ${styles.graph}`}
          aria-label="그래프"
          data-pane="main"
        >
          {children}
        </section>
      </div>
      <section
        className={`${styles.panel} ${styles.details}`}
        aria-label={detailsLabel}
        data-pane="details"
        hidden={!detailsOpen}
      >
        <header className={styles.detailsHeading}>
          <h2>{detailsLabel}</h2>
          <button
            type="button"
            onClick={onCloseDetails}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className={styles.detailsBody}>{details}</div>
      </section>
    </div>
  );
}
