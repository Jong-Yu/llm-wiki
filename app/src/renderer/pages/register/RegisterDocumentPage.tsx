import type { JSX } from 'react';
import { ImportDocumentContent } from '@renderer/features/import-document-content';
import styles from './RegisterDocumentPage.module.scss';

/** 등록 기능과 화면 간 이동만 조립하며 업무 실행은 feature에 둡니다. */
export function RegisterDocumentPage(): JSX.Element {
  return (
    <main className={styles.page}>
      <div className={styles.grid}>
        <section aria-label="문서 등록">
          <ImportDocumentContent />
        </section>
      </div>
    </main>
  );
}
