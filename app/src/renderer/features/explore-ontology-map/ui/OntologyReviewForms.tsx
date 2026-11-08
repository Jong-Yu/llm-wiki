import { useId, useState } from 'react';
import type { JSX, SubmitEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import {
  editedValue,
  initialReviewValues,
  policyInput,
  reviewInput,
  reviewLeaves,
  reviewFormSchema,
} from '../model/ontologyReviewForm';
import type { ReviewFormValues } from '../model/ontologyReviewForm';
import type { CorrectionBasis } from '../model/ontologyMap.types';
import type { DecisionCommand } from '../model/useOntologyDecision';
import { valueObject } from '../model/buildOntologyGraph';
import { OntologyAssertionFields } from './OntologyAssertionFields';
import styles from './OntologyMapWorkspace.module.scss';

export type ReviewFormProps = {
  basis: CorrectionBasis;
  blocked: boolean;
  onSubmit: (command: DecisionCommand) => Promise<void>;
};
type AssertionFormProps = ReviewFormProps & { mode: 'review' | 'policy' };

/** 두 판단의 초안은 분리하고 같은 구조 필드 입력만 재사용합니다. */
function AssertionForm({
  basis,
  blocked,
  onSubmit,
  mode,
}: AssertionFormProps): JSX.Element {
  const errorId = useId();
  const base = mode === 'policy' ? policyInput(basis) : reviewInput(basis);
  const leaves = reviewLeaves(base);
  const form = useForm<ReviewFormValues>({
    resolver: zodResolver(reviewFormSchema),
    defaultValues: initialReviewValues(leaves),
  });
  const action = useWatch({ control: form.control, name: 'action' });
  const [error, setError] = useState<string | null>(null);
  const claim = basis.assertion.claim;
  const candidate = claim?.collection === 'relation_candidates';
  const permission = mode === 'policy' ? 'ontology_policy' : 'ontology_review';
  const locked =
    blocked ||
    !basis.scope.permissions.includes(permission) ||
    !claim ||
    (mode === 'policy' && candidate);
  const edit = mode === 'policy' || action === 'edit';
  /** 현재 고정 판본과 전체 입력만 전송합니다. 후보 확정은 제출 문구로 명시합니다. */
  async function submit(values: ReviewFormValues): Promise<void> {
    if (locked || !claim) return;
    let replacement: KnowledgeValue | null = null;
    try {
      if (edit) {
        replacement = valueObject(editedValue(base, leaves, values));
        if (!replacement) throw new Error('입력 형식을 확인해 주세요.');
      }
      setError(null);
    } catch (caught: unknown) {
      setError(
        caught instanceof Error ? caught.message : '입력 값을 확인해 주세요.',
      );
      return;
    }
    const common = {
      document: basis.assertion.document,
      claim_id: claim.claim_id,
      expected_state_revision: basis.assertion.knowledge.stateRevision,
      reason: values.reason,
    };
    if (mode === 'policy' && replacement)
      await onSubmit({
        connectionId: basis.scope.connectionId,
        operation: 'policy',
        input: { ...common, replacement },
      });
    else
      await onSubmit({
        connectionId: basis.scope.connectionId,
        operation: 'review',
        input: { ...common, action: values.action, replacement },
      });
  }
  return (
    <form
      className={styles.form}
      onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
        void form.handleSubmit(submit)(event);
      }}
    >
      {mode === 'policy' && (
        <p className={styles.taskHint}>
          원문 사실과 별도로 기록합니다. 작성자·이유·시각이 판단의 근거로
          남습니다.
        </p>
      )}
      {!basis.scope.permissions.includes(permission) && (
        <p role="status">
          이 작업의 권한이 없습니다. 기록은 조회할 수 있습니다.
        </p>
      )}
      {candidate && (
        <p className={styles.notice}>
          미확정 후보입니다. 수용 또는 정정 후 수용은 실제 원문 인용을 검증해
          관계로 확정합니다. 근거가 부족하면 보류해 주세요.
        </p>
      )}
      <fieldset disabled={locked}>
        {mode === 'review' && (
          <label>
            검토 결과
            <select {...form.register('action')}>
              <option value="accept">
                {candidate ? '원문 대조 후 후보 수용' : '원문 대조 확인'}
              </option>
              <option value="edit">
                {candidate ? '원문 근거 정정 후 후보 수용' : '원문 근거 정정'}
              </option>
              <option value="reject">거절</option>
              <option value="defer">보류</option>
            </select>
          </label>
        )}
        {edit && (
          <OntologyAssertionFields
            leaves={leaves}
            form={form}
            entities={
              mode === 'policy'
                ? basis.assertion.knowledge.effectiveGraph.entities
                : basis.assertion.knowledge.machineGraph.entities
            }
            lockContext={mode === 'policy'}
          />
        )}
        <label>
          {mode === 'policy' ? '업무 판단 이유' : '검토 이유'}
          <textarea
            {...form.register('reason')}
            rows={3}
            aria-invalid={!!form.formState.errors.reason}
            aria-describedby={
              form.formState.errors.reason ? errorId : undefined
            }
          />
        </label>
        {form.formState.errors.reason && (
          <p role="alert" id={errorId}>
            {form.formState.errors.reason.message}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit">
          {mode === 'policy'
            ? '업무 판단 기록'
            : candidate && (action === 'edit' || action === 'accept')
              ? '근거 확인 후 후보 수용 기록'
              : '검토 결과 기록'}
        </button>
      </fieldset>
    </form>
  );
}

/** 원문 근거 검토의 초안과 판정을 소유합니다. */
export function OntologySourceReviewForm(props: ReviewFormProps): JSX.Element {
  return <AssertionForm {...props} mode="review" />;
}
/** 전문가 정책의 별도 초안을 현재 허용 관점에 고정합니다. */
export function OntologyExpertPolicyForm(props: ReviewFormProps): JSX.Element {
  return <AssertionForm {...props} mode="policy" />;
}
