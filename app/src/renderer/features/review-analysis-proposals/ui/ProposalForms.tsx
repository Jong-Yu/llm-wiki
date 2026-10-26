import { useEffect } from 'react';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type {
  DocumentKnowledge,
  KnowledgeClaim,
} from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import {
  prepareFieldsSchema,
  submitFieldsSchema,
  decisionFieldsSchema,
  completionFieldsSchema,
} from '../model/analysisProposal.schema';
import type {
  PrepareFields,
  SubmitFields,
  DecisionFields,
  CompletionFields,
  ProposalRecord,
  ProposalClaim,
} from '../model/analysisProposal.schema';
import styles from './ReviewAnalysisProposals.module.scss';
import type { ProposalFormDrafts } from '../model/ProposalFormDrafts';

type PrepareFormProps = {
  drafts: ProposalFormDrafts;
  draftKey: string;
  document: string;
  disabled: boolean;
  onPrepare: (values: PrepareFields) => Promise<void>;
};
type SubmitFormProps = {
  drafts: ProposalFormDrafts;
  draftKey: string;
  record: ProposalRecord;
  disabled: boolean;
  onSubmit: (values: SubmitFields) => void;
};
type DecisionFormProps = {
  drafts: ProposalFormDrafts;
  canRestore: boolean;
  draftKey: string;
  claim: ProposalClaim;
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
type FormErrorsProps = { errors: unknown };

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
function FormErrors({ errors }: FormErrorsProps): JSX.Element {
  return (
    <div role="alert">
      {[...new Set(errorMessages(errors))].map(
        (message: string): JSX.Element => (
          <p key={message}>{message}</p>
        ),
      )}
    </div>
  );
}

/** 새 추출 입력 준비는 현재 Wiki 전체와 명시한 맥락에 한정합니다. */
export function ProposalPrepareForm({
  drafts,
  draftKey,
  document,
  disabled: externalDisabled,
  onPrepare,
}: PrepareFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<PrepareFields>({
    resolver: zodResolver(prepareFieldsSchema),
    defaultValues: drafts.prepare.get(draftKey) ?? { document, contexts: '[]' },
  });
  const disabled = externalDisabled || isSubmitting;
  useEffect(
    (): (() => void) => (): void => {
      drafts.prepare.set(draftKey, getValues());
      drafts.changed();
    },
    [draftKey, getValues, drafts],
  );
  return (
    <form
      className={styles.form}
      onChange={(): void => {
        drafts.prepare.set(draftKey, getValues());
        drafts.changed();
      }}
      onSubmit={handleSubmit(onPrepare)}
    >
      <h2>현재 Wiki로 추출안 준비</h2>
      <label>
        Wiki 문서 경로
        <input
          {...register('document')}
          aria-invalid={!!errors.document}
          disabled={disabled}
          placeholder="문서.md"
        />
      </label>
      <details>
        <summary>함께 고정할 맥락 문서</summary>
        <p>최대 7개. 각 항목은 document, required, reason을 포함합니다.</p>
        <label>
          맥락 문서 JSON
          <textarea
            {...register('contexts')}
            rows={4}
            disabled={disabled}
            aria-invalid={!!errors.contexts}
          />
        </label>
      </details>
      <FormErrors errors={errors} />
      <Button type="submit" disabled={disabled}>
        전체 원문·이전 추출 고정
      </Button>
      <p>
        원문을 고정해 검토 초안을 만듭니다. AI 실행과 그래프 적용은 별도입니다.
      </p>
    </form>
  );
}

/** 기존 ID의 읽기만 수행하며 열람을 새 분석 실행으로 바꾸지 않습니다. */
type ProposalLookupFormProps = {
  disabled: boolean;
  onRead: (id: string) => void;
};
/** 기존 추출안의 명시 ID만 조회합니다. */
export function ProposalLookupForm({
  disabled,
  onRead,
}: ProposalLookupFormProps): JSX.Element {
  const schema = z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/, '32자리 추출안 ID를 입력해 주세요.'),
  });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ id: string }>({
    resolver: zodResolver(schema),
    defaultValues: { id: '' },
  });
  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit((values: { id: string }): void =>
        onRead(values.id),
      )}
    >
      <label>
        기존 추출안 ID
        <input
          {...register('id')}
          aria-invalid={!!errors.id}
          disabled={disabled}
        />
      </label>
      <FormErrors errors={errors} />
      <Button type="submit" variant="secondary" disabled={disabled}>
        추출안 조회
      </Button>
    </form>
  );
}

/** 새 전체 결과와 재추출 결정의 명시 대응을 같은 CAS 기준으로 제출합니다. */
export function ProposalSubmitForm({
  drafts,
  draftKey,
  record,
  disabled,
  onSubmit,
}: SubmitFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<SubmitFields>({
    resolver: zodResolver(submitFieldsSchema),
    defaultValues: drafts.submit.get(draftKey) ?? {
      whole: record.submission
        ? JSON.stringify(record.submission, null, 2)
        : '',
      resolves: '',
      bindings: '[]',
    },
  });
  useEffect(
    (): (() => void) => (): void => {
      drafts.submit.set(draftKey, getValues());
      drafts.changed();
    },
    [draftKey, getValues, drafts],
  );
  return (
    <form
      className={styles.form}
      onChange={(): void => {
        drafts.submit.set(draftKey, getValues());
        drafts.changed();
      }}
      onSubmit={handleSubmit(onSubmit)}
    >
      <h2>새 전체 추출안 제출</h2>
      <details>
        <summary>보존된 이전 편집 입력</summary>
        {[...drafts.submit.entries()]
          .filter(
            ([key]: [string, SubmitFields]): boolean =>
              key !== draftKey &&
              key.slice(0, key.lastIndexOf(':')) ===
                draftKey.slice(0, draftKey.lastIndexOf(':')),
          )
          .map(([key, draft]: [string, SubmitFields]): JSX.Element => (
            <pre key={key}>{JSON.stringify(draft, null, 2)}</pre>
          ))}
      </details>
      <p>
        관계·속성·후보·한정어를 포함한 전체 결과를 제출합니다. 현재 관점의
        일부만으로 덮어쓰지 않습니다.
      </p>
      <label>
        전체 추출 JSON
        <textarea
          {...register('whole')}
          rows={14}
          disabled={disabled}
          aria-invalid={!!errors.whole}
          spellCheck={false}
        />
      </label>
      <label>
        해결한 재추출 결정 ID · 줄 또는 쉼표 구분
        <textarea
          {...register('resolves')}
          rows={2}
          disabled={disabled}
          aria-invalid={!!errors.resolves}
        />
      </label>
      <label>
        새 claim ID의 명시 대응 JSON
        <textarea
          {...register('bindings')}
          rows={4}
          disabled={disabled}
          aria-invalid={!!errors.bindings}
        />
      </label>
      <p>
        인용 변경으로 ID가 달라졌다면 decision_id, new_claim_id, reason을
        입력합니다. 이전 승인은 이식되지 않습니다.
      </p>
      <FormErrors errors={errors} />
      <Button type="submit" disabled={disabled}>
        전체 추출안을 초안으로 제출
      </Button>
    </form>
  );
}

/** 미발견 관찰을 이번 비교의 제외·근거 있는 복구 초안·재추출 요청으로 기록합니다. */
export function MissingClaimDecisionForm({
  drafts,
  canRestore,
  draftKey,
  claim,
  disabled,
  onDecide,
}: DecisionFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    getValues,
    control,
    formState: { errors },
  } = useForm<DecisionFields>({
    resolver: zodResolver(decisionFieldsSchema),
    defaultValues: drafts.decision.get(draftKey) ?? {
      action: 'reextract',
      reason: '',
      evidence: '',
      replacement: '',
      checkedWhole: false,
    },
  });
  const action = useWatch({ control, name: 'action' });
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
      <code>{claim.claim_id}</code>
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
        />
      </label>
      <label>
        현재 전체 원문의 정확한 인용
        <textarea
          {...register('evidence')}
          rows={3}
          disabled={disabled}
          aria-invalid={!!errors.evidence}
        />
      </label>
      {action === 'exclude' && (
        <label className={styles.check}>
          <input
            type="checkbox"
            {...register('checkedWhole')}
            disabled={disabled}
          />
          현재 전체 원문을 확인했습니다. 제외는 과거 사실의 삭제·부정이
          아닙니다.
        </label>
      )}
      {action === 'keep' && (
        <label>
          복구할 전체 항목 JSON
          <textarea
            {...register('replacement')}
            rows={6}
            disabled={disabled}
            aria-invalid={!!errors.replacement}
          />
          <span>
            기존 collection에 추가할 한 항목입니다. evidence는 위 인용과 같아야
            합니다.
          </span>
        </label>
      )}
      {action === 'reextract' && (
        <p>
          요청 기록 후 전체 재추출 결과를 제출하고 바뀐 claim ID를 명시
          대응합니다. 여기서 AI가 실행되지는 않습니다.
        </p>
      )}
      {action === 'keep' && (
        <p>복구 초안을 전체 적용한 뒤 새 세대의 실제 검토가 필요합니다.</p>
      )}
      <FormErrors errors={errors} />
      <Button type="submit" disabled={disabled}>
        미발견 판단 기록
      </Button>
    </form>
  );
}

/** 최신 실제 accept/edit 주장만 선택하고 그 검토 판본으로 명시 범위를 완료합니다. */
export function ProposalCompletionForm({
  drafts,
  draftKey,
  review,
  disabled,
  onComplete,
}: CompleteFormProps): JSX.Element {
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
        복구·재추출 관계의 실제 새 세대 검토는 서버가 함께 확인합니다. 미선택
        주장과 문서 전체는 승인되지 않습니다.
      </p>
      {review.claims.map((claim: KnowledgeClaim): JSX.Element => (
        <label className={styles.check} key={claim.claim_id}>
          <input
            type="checkbox"
            {...register('reviewed')}
            value={claim.claim_id}
            disabled={disabled || !['accept', 'edit'].includes(claim.decision)}
          />
          <span>
            {claim.decision} · {claim.claim_id}
          </span>
        </label>
      ))}
      <label>
        완료 이유
        <textarea
          {...register('reason')}
          rows={3}
          disabled={disabled}
          aria-invalid={!!errors.reason}
        />
      </label>
      <label className={styles.check}>
        <input type="checkbox" {...register('confirmed')} disabled={disabled} />
        이번 미발견 처리와 위 선택 범위만 완료합니다.
      </label>
      <FormErrors errors={errors} />
      <Button type="submit" disabled={disabled}>
        명시 범위 완료 기록
      </Button>
    </form>
  );
}
