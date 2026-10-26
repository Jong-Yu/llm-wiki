import type { JSX, ComponentPropsWithRef } from 'react';
import { Field } from './Field';
import type { FieldControlProps, FieldPresentationProps } from './Field';
import styles from './FieldControl.module.scss';

export type TextFieldProps = Omit<ComponentPropsWithRef<'input'>, 'children'> &
  FieldPresentationProps;

/** 네이티브 input의 값·이벤트·ref를 유지하는 한 줄 입력입니다. */
export function TextField({
  label,
  description,
  error,
  id,
  required,
  className,
  type = 'text',
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ...props
}: TextFieldProps): JSX.Element {
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
        <input
          {...props}
          {...controlProps}
          type={type}
          required={required}
          className={[styles.control, className].filter(Boolean).join(' ')}
        />
      )}
    </Field>
  );
}
