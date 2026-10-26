import { useId } from 'react';
import type { JSX, AriaAttributes, ReactNode } from 'react';
import styles from './Field.module.scss';

export type FieldPresentationProps = {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
};

export type FieldControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
};

export type FieldProps = FieldPresentationProps & {
  id?: string;
  required?: boolean;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  children: (props: FieldControlProps) => ReactNode;
};

/** 라벨·도움말·오류와 입력의 접근 가능한 연결만 소유합니다. */
export function Field({
  id,
  label,
  description,
  error,
  required,
  className,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  children,
}: FieldProps): JSX.Element {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hasDescription =
    description != null && description !== false && description !== '';
  const hasError = error != null && error !== false && error !== '';
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const descriptionIds =
    [describedBy, hasDescription && descriptionId, hasError && errorId]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
        {required ? (
          <span aria-hidden="true" className={styles.required}>
            {' '}
            *
          </span>
        ) : null}
      </label>
      {hasDescription ? (
        <div id={descriptionId} className={styles.description}>
          {description}
        </div>
      ) : null}
      {children({
        id: controlId,
        'aria-describedby': descriptionIds,
        'aria-invalid': hasError ? true : invalid,
      })}
      {hasError ? (
        <div id={errorId} className={styles.error}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
