import { useState } from 'react';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  KnowledgeEntity,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  editedValue,
  initialReviewValues,
  policyInput,
  reviewFormSchema,
  reviewInput,
  reviewLeaves,
} from '../model/reviewForm';
import type { ReviewFormValues, ReviewLeaf } from '../model/reviewForm';
import type { ReviewContext, ReviewSelection } from '../model/review.types';
import styles from './ReviewDialog.module.scss';

type ReviewAssertionFormProps = {
  mode: 'review' | 'policy';
  selection: ReviewSelection;
  context: ReviewContext;
  disabled: boolean;
  onSubmit: (
    mode: 'review' | 'policy',
    action: 'accept' | 'edit' | 'reject' | 'defer',
    reason: string,
    replacement: KnowledgeValue | null,
  ) => void;
};
type AssertionFieldProps = {
  leaf: ReviewLeaf;
  form: UseFormReturn<ReviewFormValues, unknown>;
  entities: KnowledgeEntity[];
  readonly: boolean;
  mode: 'review' | 'policy';
};
const choiceValues: Record<string, string[]> = {
  polarity: ['positive', 'negative'],
  modality: ['asserted', 'possible', 'capability', 'planned', 'hypothetical'],
  datatype: ['text', 'number'],
};

/** 한정어와 기존 개체/값을 이름 있는 입력으로 편집하고 null 의미를 별도로 유지합니다. */
function AssertionField({
  leaf,
  form,
  entities,
  readonly,
  mode,
}: AssertionFieldProps): JSX.Element {
  const last = leaf.path.at(-1);
  const name = `leaves.${leaf.id}`;
  const unset = useWatch({ control: form.control, name: `nulls.${leaf.id}` });
  const lockedContext = mode === 'policy' && leaf.path[0] === 'context';
  const disabled = readonly || lockedContext || unset === true;
  const input = form.register(`leaves.${leaf.id}`);
  const options = typeof last === 'string' ? choiceValues[last] : undefined;
  let field: JSX.Element;
  if (
    leaf.path.length === 1 &&
    (last === 'subject' || last === 'object') &&
    leaf.kind === 'text'
  ) {
    const known = entities.some(
      (entity: KnowledgeEntity): boolean => entity.id === leaf.value,
    );
    field = (
      <SelectField {...input} label={leaf.label} disabled={disabled}>
        <option value="">개체를 선택해 주세요</option>
        {!known && leaf.value && (
          <option value={leaf.value}>{leaf.value}</option>
        )}
        {entities.map((entity: KnowledgeEntity): JSX.Element => (
          <option key={entity.id} value={entity.id}>
            {entity.label} · {entity.id}
          </option>
        ))}
      </SelectField>
    );
  } else if (leaf.kind === 'boolean' || options) {
    const choices = leaf.kind === 'boolean' ? ['true', 'false'] : options || [];
    field = (
      <SelectField {...input} label={leaf.label} disabled={disabled}>
        {!choices.includes(leaf.value) && (
          <option value={leaf.value}>{leaf.value}</option>
        )}
        {choices.map((value: string): JSX.Element => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </SelectField>
    );
  } else if (
    last === 'evidence' ||
    last === 'quote' ||
    last === 'condition' ||
    last === 'scope'
  )
    field = (
      <TextareaField
        {...input}
        label={leaf.label}
        rows={last === 'evidence' || last === 'quote' ? 4 : 2}
        disabled={disabled}
      />
    );
  else
    field = (
      <TextField
        {...input}
        label={leaf.label}
        type={leaf.kind === 'number' ? 'number' : 'text'}
        disabled={disabled}
        description={
          leaf.kind === 'viewpoints'
            ? '관점이 여러 개면 쉼표로 구분합니다.'
            : lockedContext
              ? '현재 허용 관점은 서버가 확인합니다.'
              : undefined
        }
      />
    );
  return (
    <div className={styles.assertionField} data-field={name}>
      {field}
      {leaf.kind === 'nullable' && (
        <label className={styles.nullChoice}>
          <input
            {...form.register(`nulls.${leaf.id}`)}
            type="checkbox"
            disabled={readonly || lockedContext}
          />
          미지정(null) 유지
        </label>
      )}
    </div>
  );
}

/** 검토/업무 판단의 초안은 각각 보존하며 실제 제출 전 전체 필드의 원형을 재조립합니다. */
export function ReviewAssertionForm({
  mode,
  selection,
  context,
  disabled,
  onSubmit,
}: ReviewAssertionFormProps): JSX.Element {
  const base =
    mode === 'policy'
      ? policyInput(selection, context)
      : reviewInput(selection);
  const leaves = reviewLeaves(base);
  const form = useForm<ReviewFormValues, unknown>({
    resolver: zodResolver(reviewFormSchema),
    defaultValues: initialReviewValues(leaves),
  });
  const action = useWatch({ control: form.control, name: 'action' });
  const [error, setError] = useState<string | null>(null);
  const edit = mode === 'policy' || action === 'edit';
  const requiredPermission =
    mode === 'policy' ? 'ontology_policy' : 'ontology_review';
  const allowed = context.permissions.includes(requiredPermission);
  const locked = disabled || !allowed;
  const entities = context.knowledge.effectiveGraph.entities;

  /** 현재 초안만 전송하며 모호한 숫자/구조를 강제로 문자열 주장으로 바꾸지 않습니다. */
  function submit(values: ReviewFormValues): void {
    if (locked) return;
    try {
      let replacement: KnowledgeValue | null = null;
      if (edit) {
        const candidate = editedValue(base, leaves, values);
        if (
          candidate === null ||
          typeof candidate !== 'object' ||
          Array.isArray(candidate)
        )
          throw new Error('주장 형식을 확인해 주세요.');
        replacement = candidate;
      }
      setError(null);
      onSubmit(mode, values.action, values.reason, replacement);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error ? caught.message : '입력 값을 확인해 주세요.',
      );
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={form.handleSubmit(submit)}
      noValidate
    >
      {!allowed && (
        <StatusNotice tone="warning" title="이 작업의 권한이 없습니다">
          {mode === 'policy' ? '업무 판단 권한' : '원문 근거 검토 권한'}이
          필요합니다. 현재 기록은 읽을 수 있습니다.
        </StatusNotice>
      )}
      {mode === 'policy' && (
        <StatusNotice title="전문가의 업무 판단">
          원문에서 추출한 사실과 별도로 기록합니다. 원문 인용을 만들지 않으며
          현재 허용 관점과 이유를 함께 보존합니다.
        </StatusNotice>
      )}
      <fieldset disabled={locked} className={styles.fields}>
        {mode === 'review' && (
          <SelectField {...form.register('action')} label="검토 결과">
            <option value="accept">원문 대조 확인</option>
            <option value="edit">원문 근거 정정</option>
            <option value="reject">거절</option>
            <option value="defer">보류</option>
          </SelectField>
        )}
        {edit && (
          <>
            <div className={styles.assertionFields}>
              {leaves
                .filter((leaf: ReviewLeaf): boolean => leaf.primary)
                .map((leaf: ReviewLeaf): JSX.Element => (
                  <AssertionField
                    key={leaf.id}
                    leaf={leaf}
                    form={form}
                    entities={entities}
                    readonly={locked}
                    mode={mode}
                  />
                ))}
            </div>
            <details className={styles.details}>
              <summary>추가 출처·구조 필드</summary>
              <p className={styles.muted}>
                기존 필드는 생략하지 않고 보존합니다. 변경할 때 실제 근거와 함께
                확인하세요.
              </p>
              <div className={styles.assertionFields}>
                {leaves
                  .filter((leaf: ReviewLeaf): boolean => !leaf.primary)
                  .map((leaf: ReviewLeaf): JSX.Element => (
                    <AssertionField
                      key={leaf.id}
                      leaf={leaf}
                      form={form}
                      entities={entities}
                      readonly={locked}
                      mode={mode}
                    />
                  ))}
              </div>
            </details>
          </>
        )}
        <TextareaField
          {...form.register('reason')}
          label={mode === 'policy' ? '업무 판단 이유' : '검토 이유'}
          required
          rows={3}
          maxLength={1000}
          error={form.formState.errors.reason?.message}
        />
      </fieldset>
      {error && (
        <StatusNotice tone="error" title="입력을 확인해 주세요">
          {error}
        </StatusNotice>
      )}
      <Button type="submit" disabled={locked}>
        {mode === 'policy' ? '업무 판단 기록' : '검토 결과 기록'}
      </Button>
    </form>
  );
}
