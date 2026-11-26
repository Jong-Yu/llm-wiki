import type { ChangeEvent, JSX, SubmitEvent } from 'react';
import { useRef } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { Field } from '@renderer/shared/ui/Field';
import type { FieldControlProps } from '@renderer/shared/ui/Field';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useErrorReport } from '../model/useErrorReport';
import styles from './ErrorReportForm.module.scss';

type ErrorReportFormProps = { connectionId: string };

/** 텍스트 입력과 보고 완료만 제공하는 단일 입력 폼입니다. */
export function ErrorReportForm({
  connectionId,
}: ErrorReportFormProps): JSX.Element {
  const model = useErrorReport(connectionId);
  const input = useRef<HTMLTextAreaElement>(null);
  const sending = model.state === 'sending';
  return (
    <form
      className={styles.form}
      onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (!model.content.trim()) input.current?.focus();
        void model.submit();
      }}
    >
      <Field
        label="오류 내용"
        error={
          model.error ? <span role="alert">{model.error}</span> : undefined
        }
      >
        {(control: FieldControlProps): JSX.Element => (
          <textarea
            {...control}
            ref={input}
            rows={10}
            className={styles.input}
            value={model.content}
            readOnly={sending}
            placeholder="어떤 문제가 발생했는지 적어 주세요."
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
              model.changeContent(event.currentTarget.value)
            }
          />
        )}
      </Field>
      <div className={styles.actions}>
        <Button
          type="submit"
          className={styles.submitButton}
          disabled={sending}
          aria-busy={sending}
        >
          <span className={styles.buttonLabel}>
            {sending ? '보고 중…' : '보고하기'}
          </span>
          <span className={styles.buttonMeasure} aria-hidden="true">
            보고 중…
          </span>
        </Button>
      </div>
      {model.state === 'sent' && (
        <StatusNotice tone="success" title="오류를 보고했습니다." />
      )}
    </form>
  );
}
