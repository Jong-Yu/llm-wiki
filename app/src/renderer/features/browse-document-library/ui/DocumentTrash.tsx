import { useEffect, useId, useRef } from 'react';
import type { JSX, SyntheticEvent } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { documentDisplayName } from '@renderer/domains/documents';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import type { TrashItem, TrashTarget } from '../api/documentTrash.api';
import { trashTarget } from '../api/documentTrash.api';
import type { DocumentTrashModel } from '../model/useDocumentTrash';
import styles from './DocumentLibrary.module.scss';

type DocumentTrashProps = { model: DocumentTrashModel; showItems?: boolean };

/** 원본 이름과 Wiki 제목은 목록과 같은 기준으로 표시합니다. */
export function trashTitle(target: TrashTarget): string {
  if (target.kind === 'source' || 'deleted_at' in target)
    return documentDisplayName(target.title);
  return documentDisplayName(
    target.document,
    typeof target.metadata?.title === 'string'
      ? target.metadata.title
      : undefined,
  );
}

/** 휴지통 확인은 실제 대상 이름과 연쇄 삭제 여부를 설명하고 네이티브 대화상자로 초점을 보존합니다. */
export function DocumentTrash({
  model,
  showItems = false,
}: DocumentTrashProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();
  useEffect((): void => {
    if (model.pending && !dialog.current?.open) dialog.current?.showModal();
    else if (!model.pending && dialog.current?.open) dialog.current.close();
  }, [model.pending]);
  return (
    <>
      {model.message && <p role="status">{model.message}</p>}
      {showItems && (
        <section className={styles.trashPanel} aria-label="휴지통">
          <div className={styles.toolbar}>
            <p>삭제한 문서를 복원할 수 있습니다.</p>
            <Button
              variant="surface"
              disabled={model.loading || model.busy}
              onClick={model.refresh}
            >
              새로 고침
            </Button>
          </div>
          <p>원본과 생성된 Wiki는 각각 관리합니다.</p>
          {model.error && <p role="alert">{model.error}</p>}
          {model.loading && <p role="status">휴지통을 불러오는 중입니다.</p>}
          {model.page?.incomplete && (
            <p role="status">
              일부 항목만 확인했습니다. 조회되지 않은 항목이 있을 수 있습니다.
            </p>
          )}
          {model.page?.items.length === 0 && !model.loading && (
            <p>휴지통이 비어 있습니다.</p>
          )}
          <ul className={styles.trashList}>
            {model.page?.items.map((item: TrashItem): JSX.Element => (
              <li key={`${item.kind}:${trashTarget(item).id}`}>
                <div>
                  <strong>{trashTitle(item)}</strong>
                  <small>
                    {item.kind === 'wiki' ? 'Wiki 문서' : '등록 원본'} ·{' '}
                    {formatTimestamp(item.deleted_at)}
                  </small>
                </div>
                <Button
                  variant="surface"
                  disabled={model.busy}
                  aria-label={`${trashTitle(item)} 복원`}
                  onClick={(): void => model.choose(item, true)}
                >
                  복원
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <dialog
        ref={dialog}
        className={styles.trashDialog}
        aria-labelledby={heading}
        aria-describedby={description}
        onCancel={(event: SyntheticEvent<HTMLDialogElement>): void => {
          if (model.busy) event.preventDefault();
          else model.cancel();
        }}
      >
        <h2 id={heading}>
          {model.pending?.restore
            ? '문서를 복원할까요?'
            : '휴지통으로 이동할까요?'}
        </h2>
        {model.pending && (
          <>
            <strong>{trashTitle(model.pending.target)}</strong>
            <p id={description}>
              {model.pending.restore
                ? '원래 목록에 다시 표시됩니다. Wiki 문서는 검색과 AI 답변 근거에서도 다시 사용할 수 있습니다.'
                : model.pending.target.kind === 'source'
                  ? '원본을 목록에서 제거합니다. 이미 생성된 Wiki 문서는 유지되며, 원본 파일과 판본은 보존됩니다.'
                  : '문서를 목록·검색·새 AI 답변 근거에서 제외합니다. 기존 이력과 이전 답변의 근거는 보존되며 휴지통에서 복원할 수 있습니다.'}
            </p>
          </>
        )}
        <div className={styles.actions}>
          <Button
            variant="surface"
            disabled={model.busy}
            onClick={model.cancel}
          >
            취소
          </Button>
          <Button
            disabled={model.busy}
            onClick={(): void => {
              void model.confirm();
            }}
          >
            {model.busy
              ? '처리 중…'
              : model.pending?.restore
                ? '복원'
                : '휴지통으로 이동'}
          </Button>
        </div>
      </dialog>
    </>
  );
}
