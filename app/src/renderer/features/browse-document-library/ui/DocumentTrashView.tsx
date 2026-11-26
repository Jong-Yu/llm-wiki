import type { JSX } from 'react';
import type { TrashScope } from '../api/documentTrash.api';
import { useDocumentTrash } from '../model/useDocumentTrash';
import { DocumentTrash } from './DocumentTrash';
import styles from './DocumentLibrary.module.scss';

type DocumentTrashViewProps = { scope: TrashScope };

/** 문서 목록과 분리된 화면에서 보관된 항목과 복원 행동만 제공합니다. */
export function DocumentTrashView({
  scope,
}: DocumentTrashViewProps): JSX.Element {
  const model = useDocumentTrash(scope, undefined, true);
  return (
    <section className={styles.library} aria-label="문서 휴지통">
      <DocumentTrash model={model} showItems />
    </section>
  );
}
