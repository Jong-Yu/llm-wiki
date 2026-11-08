import { useId, useState } from 'react';
import type { JSX, SubmitEvent } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { valueObject } from '../model/buildOntologyGraph';
import { ontologyEndpointLabel } from '../model/ontologyLabels';
import type {
  CorrectionBasis,
  CorrectionReceipt,
} from '../model/ontologyMap.types';
import { relationPredicateLabel } from '../model/ontologyRelation.schema';
import {
  editedValue,
  initialReviewValues,
  reviewFormSchema,
  reviewInput,
  reviewLeaves,
} from '../model/ontologyReviewForm';
import type { ReviewFormValues } from '../model/ontologyReviewForm';
import { useOntologyDecision } from '../model/useOntologyDecision';
import { OntologyAssertionFields } from './OntologyAssertionFields';
import styles from './OntologyClaimWorkbench.module.scss';

type Judgment = ReviewFormValues['action'];
type OntologyClaimJudgmentProps = {
  basis: CorrectionBasis;
  onDecided: (receipt: CorrectionReceipt) => void;
  onInvalidate: () => void;
};
const judgments: readonly {
  action: Judgment;
  label: string;
  icon: IconName;
}[] = [
  { action: 'accept', label: '승인', icon: 'check' },
  { action: 'edit', label: '수정', icon: 'pencil' },
  { action: 'defer', label: '보류', icon: 'pause' },
  { action: 'reject', label: '반려', icon: 'x' },
];

/** 근거 줄 아래에서 승인·수정·보류·반려를 고르고 이유(모두 필수)와 함께 저장합니다. */
export function OntologyClaimJudgment({
  basis,
  onDecided,
  onInvalidate,
}: OntologyClaimJudgmentProps): JSX.Element {
  const errorId = useId();
  const base = reviewInput(basis);
  const leaves = reviewLeaves(base);
  const form = useForm<ReviewFormValues>({
    resolver: zodResolver(reviewFormSchema),
    defaultValues: initialReviewValues(leaves),
  });
  const [chosen, setChosen] = useState<Judgment | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const model = useOntologyDecision(basis, onDecided, onInvalidate);
  const claim = basis.assertion.claim;
  const knowledge = basis.assertion.knowledge;
  const permissions = basis.scope.permissions;
  const canReview =
    permissions.includes('ontology_review') &&
    !!claim &&
    !claim.ambiguous &&
    knowledge.status === 'ready' &&
    knowledge.machineGraph.needs_reextraction !== true &&
    !model.blocked;
  const entities = knowledge.machineGraph.entities;
  const value = basis.assertion.value;
  const subject = ontologyEndpointLabel(value.subject, entities);
  const object = ontologyEndpointLabel(value.object, entities);
  const predicate =
    typeof value.predicate === 'string'
      ? relationPredicateLabel(value.predicate)
      : typeof value.property === 'string'
        ? value.property
        : '';
  const origin =
    basis.assertion.origin === 'candidate'
      ? '연결 후보'
      : basis.assertion.origin === 'expert'
        ? '전문가 의견'
        : 'AI 추출';

  /** 판단을 고르면 같은 자리에서 이유 입력이 열리고, 이미 쓴 이유는 유지합니다. */
  function choose(action: Judgment): void {
    setChosen(action);
    setInputError(null);
    form.setValue('action', action);
  }

  /** 읽은 판본과 이유를 그대로 보내고, 수정만 편집한 전체 값을 함께 보냅니다. */
  async function submit(values: ReviewFormValues): Promise<void> {
    if (!canReview || !claim || !chosen) return;
    let replacement: KnowledgeValue | null = null;
    if (chosen === 'edit') {
      try {
        replacement = valueObject(editedValue(base, leaves, values));
      } catch (caught: unknown) {
        setInputError(
          caught instanceof Error ? caught.message : '입력 값을 확인해 주세요.',
        );
        return;
      }
      if (!replacement) {
        setInputError('입력 형식을 확인해 주세요.');
        return;
      }
    }
    setInputError(null);
    await model.submit({
      connectionId: basis.scope.connectionId,
      operation: 'review',
      input: {
        document: basis.assertion.document,
        claim_id: claim.claim_id,
        expected_state_revision: knowledge.stateRevision,
        reason: values.reason,
        action: chosen,
        replacement,
      },
    });
  }

  return (
    <div className={styles.judgment} aria-label="판단">
      <div className={styles.relationLine}>
        <strong>{subject}</strong>
        <span className={styles.predicate}>{predicate} →</span>
        <strong>{object}</strong>
        <span className={styles.origin}>{origin}</span>
      </div>
      <div
        className={styles.judgmentActions}
        role="group"
        aria-label="판단 선택"
      >
        {judgments.map((item: (typeof judgments)[number]): JSX.Element => (
          <button
            key={item.action}
            type="button"
            data-action={item.action}
            aria-pressed={chosen === item.action}
            disabled={!canReview}
            onClick={(): void => choose(item.action)}
          >
            <Icon name={item.icon} size={14} />
            {item.label}
          </button>
        ))}
        {permissions.includes('ontology_policy') && (
          <Link
            className={styles.expertLink}
            to={`/ontology?view=relation-new&document=${encodeURIComponent(basis.assertion.document)}`}
          >
            전문가 의견으로 추가
          </Link>
        )}
      </div>
      {chosen && (
        <form
          className={styles.judgmentForm}
          onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
            void form.handleSubmit(submit)(event);
          }}
        >
          <fieldset disabled={!canReview}>
            {chosen === 'edit' && (
              <OntologyAssertionFields
                leaves={leaves}
                form={form}
                entities={entities}
              />
            )}
            <label>
              이유
              <textarea
                {...form.register('reason')}
                rows={2}
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
            {inputError && <p role="alert">{inputError}</p>}
            <div className={styles.formButtons}>
              <button type="submit" className={styles.saveButton}>
                저장
              </button>
              <button
                type="button"
                onClick={(): void => {
                  setChosen(null);
                  setInputError(null);
                }}
              >
                취소
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {model.state.phase === 'error' && (
        <p role="alert" className={styles.failure}>
          {model.state.error.message}
        </p>
      )}
    </div>
  );
}
