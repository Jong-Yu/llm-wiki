import type { JSX, ComponentPropsWithRef } from 'react';
import { Field } from './Field';
import type { FieldControlProps, FieldPresentationProps } from './Field';
import styles from './FieldControl.module.scss';

export type TextareaFieldProps = Omit<
  ComponentPropsWithRef<'textarea'>,
  'children'
> &
  FieldPresentationProps;

/** 본문을 자르지 않고 네이티브 textarea의 편집 동작을 전달합니다. */
export function TextareaField({
  label,
  description,
  error,
  id,
  required,
  className,
  rows = 4,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...props
}: TextareaFieldProps): JSX.Element {
  return (
    <Field
      id={id}
      label={label}
      description={description}
      error={error}
      required={required}
      aria-describedby={describedBy}
      aria-invalid={invalid}
    >
      {(controlProps: FieldControlProps): JSX.Element => (
        <textarea
          {...props}
          {...controlProps}
          rows={rows}
          required={required}
          className={[styles.control, styles.textarea, className]
            .filter(Boolean)
            .join(' ')}
        />
      )}
    </Field>
  );
}
