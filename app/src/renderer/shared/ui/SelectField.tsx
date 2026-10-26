import type { JSX, ComponentPropsWithRef } from 'react';
import { Field } from './Field';
import type { FieldControlProps, FieldPresentationProps } from './Field';
import styles from './FieldControl.module.scss';

export type SelectFieldProps = ComponentPropsWithRef<'select'> &
  FieldPresentationProps;

/** option children과 네이티브 select의 선택·키보드 동작을 유지합니다. */
export function SelectField({
  label,
  description,
  error,
  id,
  required,
  className,
  children,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...props
}: SelectFieldProps): JSX.Element {
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
        <select
          {...props}
          {...controlProps}
          required={required}
          className={[styles.control, className].filter(Boolean).join(' ')}
        >
          {children}
        </select>
      )}
    </Field>
  );
}
