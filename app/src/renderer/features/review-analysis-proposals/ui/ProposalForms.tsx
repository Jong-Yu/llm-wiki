import { useEffect, useId } from 'react';
import type { JSX, ChangeEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  DocumentKnowledge,
  KnowledgeClaim,
  KnowledgeValue,
  KnowledgeJson,
} from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import {
  parseObject,
  decisionFieldsSchema,
  completionFieldsSchema,
} from '../model/analysisProposal.schema';
import type {
  DecisionFields,
  CompletionFields,
  ProposalClaim,
} from '../model/analysisProposal.schema';
import styles from './ReviewAnalysisProposals.module.scss';
import { ProposalClaimSummary } from './ProposalClaimSummary';
import { ProposalClaimDetails } from './ProposalGraphDetails';
import type { ProposalFormDrafts } from '../model/ProposalFormDrafts';

type DecisionFormProps = {
  drafts: ProposalFormDrafts;
  canRestore: boolean;
  draftKey: string;
  claim: ProposalClaim;
  graph: KnowledgeValue | null;
  disabled: boolean;
  onDecide: (values: DecisionFields) => void;
};
type CompleteFormProps = {
  drafts: ProposalFormDrafts;
  draftKey: string;
  review: DocumentKnowledge;
  disabled: boolean;
  onComplete: (values: CompletionFields) => void;
};
type FormErrorsProps = { errors: unknown; id: string };

/** 폼 오류 본문만 읽고 DOM 참조를 따라가지 않습니다. */
function errorMessages(errors: unknown): string[] {
  if (!errors || typeof errors !== 'object') return [];
  return Object.entries(errors).flatMap(
    ([key, value]: [string, unknown]): string[] =>
      key === 'message' && typeof value === 'string'
        ? [value]
        : key !== 'ref' && key !== 'types'
          ? errorMessages(value)
          : [],
  );
}
/** 입력 오류를 폼 가까이에 접근 가능한 텍스트로 표시합니다. */
function FormErrors({ errors, id }: FormErrorsProps): JSX.Element | null {
  const messages = [...new Set(errorMessages(errors))];
  if (messages.length === 0) return null;
  return (
    <span className={styles.fieldErrors} id={id} role="alert">
      {messages.map((message: string): JSX.Element => (
        <span key={message}>{message}</span>
      ))}
    </span>
  );
}

/** 미발견 관찰을 이번 비교의 제외·근거 있는 복구 초안·재추출 요청으로 기록합니다. */
export function MissingClaimDecisionForm({
  drafts,
  canRestore,
  draftKey,
  claim,
  graph,
  disabled,
  onDecide,
}: DecisionFormProps): JSX.Element {
  const errorId = useId();
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    control,
    formState: { errors },
  } = useForm<DecisionFields>({
    resolver: zodResolver(decisionFieldsSchema),
    defaultValues: drafts.decision.get(draftKey) ?? {
      action: 'reextract',
      reason: '',
      evidence: '',
      replacement: JSON.stringify(claim.value),
      checkedWhole: false,
    },
  });
  const action = useWatch({ control, name: 'action' });
  const evidence = useWatch({ control, name: 'evidence' });
  const replacementText = useWatch({ control, name: 'replacement' });
  const replacement = parseObject(replacementText) ?? claim.value;
  const entities = Array.isArray(graph?.entities) ? graph.entities : [];
  useEffect((): void => {
    if (action !== 'keep') return;
    const current = parseObject(getValues('replacement')) ?? claim.value;
    if (current.evidence !== evidence)
      setValue('replacement', JSON.stringify({ ...current, evidence }), {
        shouldDirty: true,
      });
  }, [action, evidence, claim.value, getValues, setValue]);
  /** 이름 선택을 내부 참조에 연결하고 기존 조건·한정어를 보존합니다. */
  function changeReplacement(key: string, value: string): void {
    setValue(
      'replacement',
      JSON.stringify({ ...replacement, [key]: value, evidence }),
      { shouldDirty: true },
    );
    drafts.decision.set(draftKey, getValues());
    drafts.changed();
  }
  /** 현재 후보의 개념 이름으로 복구 대상을 선택합니다. */
  function endpointOptions(): JSX.Element[] {
    return entities.flatMap((item: KnowledgeJson): JSX.Element[] => {
      if (
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        typeof item.id !== 'string' ||
        typeof item.label !== 'string'
      )
        return [];
      return [
        <option key={item.id} value={item.id}>
          {item.label}
        </option>,
      ];
    });
  }
  useEffect(
    (): (() => void) => (): void => {
      drafts.decision.set(draftKey, getValues());
      drafts.changed();
    },
    [draftKey, getValues, drafts],
  );
  return (
    <form
      className={styles.form}
      onChange={(): void => {
        drafts.decision.set(draftKey, getValues());
        drafts.changed();
      }}
      onSubmit={handleSubmit(onDecide)}
    >
      <h3>미발견 관계 처리</h3>

      <label>
        이번 비교의 판단
        <select {...register('action')} disabled={disabled}>
          <option value="reextract">전체 재추출 요청 기록</option>
          <option value="keep" disabled={!canRestore}>
            현재 근거로 복구 초안
          </option>
          <option value="exclude">이번 비교에서 제외</option>
        </select>
      </label>
      <label>
        판단 이유
        <textarea
          {...register('reason')}
          rows={3}
          disabled={disabled}
          aria-invalid={!!errors.reason}
          aria-describedby={errors.reason ? `${errorId}-reason` : undefined}
        />
        <FormErrors id={`${errorId}-reason`} errors={errors.reason} />
      </label>
      <label>
        현재 전체 원문의 정확한 인용
        <textarea
          {...register('evidence')}
          rows={3}
          disabled={disabled}
          aria-invalid={!!errors.evidence}
          aria-describedby={errors.evidence ? `${errorId}-evidence` : undefined}
        />
        <FormErrors id={`${errorId}-evidence`} errors={errors.evidence} />
      </label>
      {action === 'exclude' && (
        <label className={styles.check}>
          <input
            type="checkbox"
            {...register('checkedWhole')}
            aria-invalid={!!errors.checkedWhole}
            aria-describedby={
              errors.checkedWhole ? `${errorId}-checkedWhole` : undefined
            }
            disabled={disabled}
          />
          <span>
            현재 전체 원문을 확인했습니다. 제외는 과거 사실의 삭제·부정이
            아닙니다.
            <FormErrors
              id={`${errorId}-checkedWhole`}
              errors={errors.checkedWhole}
            />
          </span>
        </label>
      )}
      {action === 'keep' && (
        <section>
          <h4>복구할 관계</h4>
          <input type="hidden" {...register('replacement')} />
          <label>
            주체
            <select
              value={
                typeof replacement.subject === 'string'
                  ? replacement.subject
                  : ''
              }
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                changeReplacement('subject', event.target.value)
              }
            >
              <option value="">개념 선택</option>
              {endpointOptions()}
            </select>
          </label>
          <label>
            {claim.collection === 'attributes' ? '속성' : '관계'}
            <input
              value={
                typeof replacement.predicate === 'string'
                  ? replacement.predicate
                  : typeof replacement.property === 'string'
                    ? replacement.property
                    : ''
              }
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                changeReplacement(
                  claim.collection === 'attributes' ? 'property' : 'predicate',
                  event.target.value,
                )
              }
            />
          </label>
          {replacement.object !== undefined && (
            <label>
              대상
              <select
                value={
                  typeof replacement.object === 'string'
                    ? replacement.object
                    : ''
                }
                disabled={disabled}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                  changeReplacement('object', event.target.value)
                }
              >
                <option value="">개념 선택</option>
                {endpointOptions()}
              </select>
            </label>
          )}
          <ProposalClaimDetails value={replacement} graph={graph} />
          <FormErrors
            id={`${errorId}-replacement`}
            errors={errors.replacement}
          />
        </section>
      )}
      {action === 'reextract' && (
        <p>
          재추출이 필요하다는 판단을 기록합니다. AI 재추출은 위의 실행 버튼에서
          시작할 수 있습니다.
        </p>
      )}
      {action === 'keep' && (
        <p>복구 초안을 전체 적용한 뒤 새 버전의 실제 검토가 필요합니다.</p>
      )}
      <Button type="submit" disabled={disabled}>
        미발견 판단 기록
      </Button>
    </form>
  );
}

/** 최신 실제 accept/edit 주장만 선택하고 그 검토 버전으로 명시 범위를 완료합니다. */
export function ProposalCompletionForm({
  drafts,
  draftKey,
  review,
  disabled,
  onComplete,
}: CompleteFormProps): JSX.Element {
  const errorId = useId();
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<CompletionFields>({
    resolver: zodResolver(completionFieldsSchema),
    defaultValues: drafts.completion.get(draftKey) ?? {
      reason: '',
      reviewed: [],
      confirmed: false,
    },
  });
  useEffect(
    (): (() => void) => (): void => {
      drafts.completion.set(draftKey, getValues());
      drafts.changed();
    },
    [draftKey, getValues, drafts],
  );
  return (
    <form
      className={styles.form}
      onChange={(): void => {
        drafts.completion.set(draftKey, getValues());
        drafts.changed();
      }}
      onSubmit={handleSubmit(onComplete)}
    >
      <h2>실제 검토한 명시 범위 완료</h2>
      <p>
        복구·재추출 관계의 실제 새 버전 검토는 서버가 함께 확인합니다. 미선택
        주장과 문서 전체는 승인되지 않습니다.
      </p>
      {review.claims.map((claim: KnowledgeClaim): JSX.Element => (
        <label className={styles.check} key={claim.claim_id}>
          <input
            type="checkbox"
            {...register('reviewed')}
            aria-invalid={!!errors.reviewed}
            aria-describedby={
              errors.reviewed ? `${errorId}-reviewed` : undefined
            }
            value={claim.claim_id}
            disabled={disabled || !['accept', 'edit'].includes(claim.decision)}
          />
          <span>
            {claim.decision === 'accept'
              ? '확인됨'
              : claim.decision === 'edit'
                ? '정정됨'
                : claim.decision === 'reject'
                  ? '기각'
                  : claim.decision === 'defer'
                    ? '보류'
                    : '미검토'}{' '}
            ·{' '}
            <ProposalClaimSummary
              value={claim.reviewed_value}
              graph={review.effectiveGraph}
            />
          </span>
        </label>
      ))}
      <FormErrors id={`${errorId}-reviewed`} errors={errors.reviewed} />
      <label>
        완료 이유
        <textarea
          {...register('reason')}
          rows={3}
          disabled={disabled}
          aria-invalid={!!errors.reason}
          aria-describedby={errors.reason ? `${errorId}-reason` : undefined}
        />
        <FormErrors id={`${errorId}-reason`} errors={errors.reason} />
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          {...register('confirmed')}
          disabled={disabled}
          aria-invalid={!!errors.confirmed}
          aria-describedby={
            errors.confirmed ? `${errorId}-confirmed` : undefined
          }
        />
        <span>
          이번 미발견 처리와 위 선택 범위만 완료합니다.
          <FormErrors id={`${errorId}-confirmed`} errors={errors.confirmed} />
        </span>
      </label>
      <Button type="submit" disabled={disabled}>
        명시 범위 완료 기록
      </Button>
    </form>
  );
}
