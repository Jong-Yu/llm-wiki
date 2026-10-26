import { useEffect, useId, useRef } from 'react';
import type { JSX, ReactNode, SyntheticEvent } from 'react';
import { Button } from './Button';
import styles from './Dialog.module.scss';

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  closeLabel?: string;
  className?: string;
};

/** native modal의 focus 제한·복귀를 사용하며 실제 열림 상태는 호출자가 소유합니다. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  closeLabel = '닫기',
  className,
}: DialogProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const hasDescription = description !== undefined && description !== null;

  useEffect((): void => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  useEffect((): (() => void) => {
    const element = dialog.current;
    return (): void => {
      if (element?.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={[styles.dialog, className].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      aria-describedby={hasDescription ? descriptionId : undefined}
      aria-modal="true"
      onCancel={(event: SyntheticEvent<HTMLDialogElement>): void => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={(event: SyntheticEvent<HTMLDialogElement>): void => {
        // StrictMode의 이전 close 이벤트로 다시 열린 창을 닫지 않습니다.
        if (open && !event.currentTarget.open) onOpenChange(false);
      }}
    >
      <header className={styles.header}>
        <div>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {hasDescription && (
            <div id={descriptionId} className={styles.description}>
              {description}
            </div>
          )}
        </div>
        <Button variant="secondary" onClick={(): void => onOpenChange(false)}>
          {closeLabel}
        </Button>
      </header>
      <div className={styles.body}>{children}</div>
      {actions !== undefined && actions !== null && (
        <footer className={styles.actions}>{actions}</footer>
      )}
    </dialog>
  );
}
