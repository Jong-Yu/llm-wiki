import { useForm } from 'react-hook-form';
import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import type { JSX } from 'react';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type {
  ActionValues,
  CorrespondenceValue,
  Detail,
  Failure,
  Intent,
  Judgment,
  Prepared,
  Scope,
} from '../model/correspondence.schema';
import {
  actionSchema,
  emptyValue,
  stateLabel,
  valueSchema,
} from '../model/correspondence.schema';
import {
  CorrespondenceDetails,
  CorrespondenceValueEditor,
  CorrespondenceValueView,
} from './CorrespondenceValue';
import styles from './ManageCorrespondences.module.scss';

export type EditorTarget = {
  scope: Scope;
  kind:
    | 'propose'
    | 'accept'
    | 'reject'
    | 'defer'
    | 'edit'
    | 'policy'
    | 'review_undo'
    | 'policy_undo';
  detail: Detail | null;
  judgment: Judgment | null;
};
type CorrespondenceActionFormProps = {
  target: EditorTarget;
  formId: string;
  prepared: Prepared | null;
  scope: Scope;
  locked: boolean;
  onPrepare: (intent: Intent) => Promise<void>;
  onChange: () => void;
  onInvalidated: (error: Failure) => void;
};
/** 전문가 입력의 근거 종류만 명시 전환하고 원문 제안과 모든 나머지 조건을 보존합니다. */
function defaultValue(target: EditorTarget): CorrespondenceValue | null {
  if (target.kind === 'propose') return emptyValue();
  if (target.kind !== 'edit' && target.kind !== 'policy') return null;
  const original =
    target.judgment?.value || target.detail?.source_proposal.value;
  if (!original) return null;
  return target.kind === 'policy'
    ? { ...original, basis: { kind: 'expert', reason: '', link_evidence: [] } }
    : original;
}
/** 명시 행동 하나의 전체 초안과 기준 원장을 폼 수명 동안 유지합니다. */
export function CorrespondenceActionForm({
  target,
  formId,
  prepared,
  scope,
  locked,
  onPrepare,
  onChange,
  onInvalidated,
}: CorrespondenceActionFormProps): JSX.Element {
  const form = useForm<ActionValues>({
    resolver: zodResolver(actionSchema),
    defaultValues: { reason: '', decision: 'deferred' },
  });
  const [value, setValue] = useState<CorrespondenceValue | null>(
    (): CorrespondenceValue | null => defaultValue(target),
  );
  const confirmation = useRef<HTMLElement>(null);
  useEffect((): void => {
    if (prepared) confirmation.current?.focus();
  }, [prepared]);
  /** 저장할 정확한 변경만 prepare에 보내며 아직 쓰기를 실행하지 않습니다. */
  async function submit(values: ActionValues): Promise<void> {
    const parsed = value === null ? null : valueSchema.safeParse(value);
    if (parsed && !parsed.success) {
      form.setError('root', {
        message:
          '대응 문장·원문 판본·인용·업무 범위·근거 설명을 확인해 주세요. 원문은 양쪽 모두 읽어야 합니다.',
      });
      return;
    }
    const checked = parsed?.success ? parsed.data : null;
    if (target.kind === 'propose') {
      if (checked)
        await onPrepare({
          kind: 'propose',
          value: checked,
          reason: values.reason,
        });
      return;
    }
    if (!target.detail) return;
    const basis = {
      correspondenceId: target.detail.correspondence_id,
      baseRevision: target.detail.correspondence_revision,
      baseDependencies: target.detail.dependencies,
    };
    if (target.kind === 'review_undo' || target.kind === 'policy_undo') {
      if (target.judgment)
        await onPrepare({
          ...basis,
          kind: target.kind,
          change: { event_id: target.judgment.event_id, reason: values.reason },
        });
    } else if (target.kind === 'policy') {
      if (checked)
        await onPrepare({
          ...basis,
          kind: 'policy',
          change: {
            reason: values.reason,
            replacement: checked,
            judgment_id:
              target.judgment?.lane === 'expert'
                ? target.judgment.judgment_id
                : null,
            supersedes_event_id: target.judgment?.event_id || null,
          },
        });
    } else {
      await onPrepare({
        ...basis,
        kind: 'review',
        change: {
          action: target.kind,
          reason: values.reason,
          replacement: target.kind === 'edit' ? checked : null,
          decision: target.kind === 'edit' ? values.decision : null,
        },
      });
    }
  }
  const title = actionTitle(target.kind);
  const comparison =
    value || target.judgment?.value || target.detail?.source_proposal.value;
  const reasonFields = (
    <section className={styles.fields}>
      {target.kind === 'edit' && (
        <SelectField label="수정 후 판단" {...form.register('decision')}>
          <option value="deferred">수정 후 보류</option>
          <option value="accepted">수정 후 수용</option>
        </SelectField>
      )}
      <TextareaField
        label="판단 이유"
        required
        error={form.formState.errors.reason?.message}
        {...form.register('reason')}
      />
    </section>
  );
  return (
    <form
      id={formId}
      className={styles.actionForm}
      onSubmit={form.handleSubmit(submit)}
      onChange={onChange}
      aria-label="대응 변경 작성"
    >
      {form.formState.errors.root && (
        <div className={styles.dialogFeedback}>
          <StatusNotice tone="error">
            {form.formState.errors.root.message}
          </StatusNotice>
        </div>
      )}
      <fieldset
        className={styles.editorFields}
        disabled={locked}
        hidden={prepared !== null}
      >
        {value ? (
          <CorrespondenceValueEditor
            value={value}
            scope={scope}
            expert={target.kind === 'policy'}
            existing={target.kind !== 'propose'}
            onInvalidated={onInvalidated}
            onChange={(next: CorrespondenceValue): void => {
              setValue(next);
              form.clearErrors('root');
              onChange();
            }}
          >
            {reasonFields}
          </CorrespondenceValueEditor>
        ) : (
          <div className={styles.editorColumns}>
            <section className={styles.editorPane}>
              <p className={styles.eyebrow}>판단 기록</p>
              <h3>{title}</h3>
              <StatusNotice>
                {target.judgment
                  ? `대상 판단 · ${stateLabel(target.judgment.decision)}`
                  : '선택한 대응'}
              </StatusNotice>
              {reasonFields}
            </section>
            <section className={styles.editorPane}>
              <h3>변경 대상 대조</h3>
              {comparison ? (
                <CorrespondenceValueView value={comparison} />
              ) : (
                <p>활성 내용이 없는 판단입니다. 저장된 이력을 확인해 주세요.</p>
              )}
            </section>
          </div>
        )}
      </fieldset>
      {prepared && (
        <section
          className={styles.confirmation}
          ref={confirmation}
          tabIndex={-1}
          aria-label="저장 전 대조"
        >
          <div className={styles.confirmationHeading}>
            <p className={styles.eyebrow}>저장 전 대조 · {title}</p>
            <h3>아래 내용과 근거를 확인한 뒤 명시적으로 저장하세요.</h3>
            <p>
              <strong>판단 이유</strong> · {form.getValues('reason')}
            </p>
            {target.kind === 'edit' && (
              <p>수정 후 판단 · {stateLabel(form.getValues('decision'))}</p>
            )}
          </div>
          {comparison && <CorrespondenceValueView value={comparison} />}
          <details className={styles.preparedDetails}>
            <summary>준비된 전체 변경·근거 판본</summary>
            <CorrespondenceDetails value={prepared.response} />
          </details>
        </section>
      )}
    </form>
  );
}
/** 편집과 확인 단계가 같은 행동명을 사용합니다. */
export function actionTitle(kind: EditorTarget['kind']): string {
  return {
    propose: '새 대응 제안',
    accept: '원문 근거 수용',
    reject: '제안 거절',
    defer: '판단 보류',
    edit: '원문 해석 수정',
    policy: '전문가 업무 판단',
    review_undo: '검토 되돌림',
    policy_undo: '업무 판단 되돌림',
  }[kind];
}
