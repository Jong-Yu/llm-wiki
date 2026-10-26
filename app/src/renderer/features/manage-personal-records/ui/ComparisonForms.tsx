import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type {
  KnowledgeClaim,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  currentReviewedClaims,
  listPersonal,
  preparePersonalContext,
  readPersonal,
} from '../api/personalRecords.api';
import {
  titleFormSchema,
  mappingFormSchema,
  completionFormSchema,
} from '../model/personalForms';
import type {
  MappingFormValues,
  CompletionFormValues,
} from '../model/personalForms';
import {
  claimLabel,
  contextForBasis,
  jsonText,
  newRequestId,
  readBasis,
  textValue,
} from '../model/personalRecords';
import type {
  BasisDocument,
  ClaimMapping,
  ClaimSelection,
  PersonalBasis,
  PersonalPage,
  RecordEnvelope,
} from '../model/personalRecords';
import type { PersonalFormActions } from './PersonalForms';
import styles from './ManagePersonalRecords.module.scss';

const comparisonFormSchema = titleFormSchema.extend({
  baselineId: z
    .string()
    .regex(/^[a-f0-9]{32}$/, '저장된 결과를 선택해 주세요.'),
});
type ComparisonFormValues = z.infer<typeof comparisonFormSchema>;
type MappingBuilderProps = {
  baseline: PersonalBasis;
  current: PersonalBasis;
  disabled: boolean;
  onAdd: (mapping: ClaimMapping) => void;
};
/** 자동 의미 판정 대신 실제 이전·새 주장 선택과 사용자의 대응 이유를 받습니다. */
function MappingBuilder({
  baseline,
  current,
  disabled,
  onAdd,
}: MappingBuilderProps): JSX.Element {
  const form = useForm<MappingFormValues>({
    resolver: zodResolver(mappingFormSchema),
    defaultValues: {
      document: baseline.documents[0]?.document || '',
      disposition: 'same',
      oldClaim: '',
      newClaim: '',
      reason: '',
    },
  });
  const document = useWatch({ control: form.control, name: 'document' });
  const disposition = useWatch({ control: form.control, name: 'disposition' });
  const old = baseline.documents.find(
    (item: BasisDocument): boolean => item.document === document,
  );
  const fresh = current.documents.find(
    (item: BasisDocument): boolean => item.document === document,
  );
  /** 선택지에서 확인된 ID만 대응으로 보관하며 자동 일치 항목을 만들지 않습니다. */
  function submit(values: MappingFormValues): void {
    if (
      values.disposition !== 'new' &&
      !old?.knowledge.claims.some(
        (claim: KnowledgeClaim): boolean => claim.claim_id === values.oldClaim,
      )
    )
      return;
    if (
      values.disposition !== 'missing' &&
      !fresh?.knowledge.claims.some(
        (claim: KnowledgeClaim): boolean => claim.claim_id === values.newClaim,
      )
    )
      return;
    onAdd({
      document: values.document,
      disposition: values.disposition,
      old_claim_id: values.disposition === 'new' ? null : values.oldClaim,
      new_claim_id: values.disposition === 'missing' ? null : values.newClaim,
      reason: values.reason,
    });
    form.setValue('oldClaim', '');
    form.setValue('newClaim', '');
    form.setValue('reason', '');
  }
  return (
    <form className={styles.mappingForm} onSubmit={form.handleSubmit(submit)}>
      <h3>주장 대응 추가</h3>
      <p className={styles.muted}>
        같음·변경·미발견·신규는 사용자가 선택한 대응입니다. 원문의 삭제나 자동
        검토 승인을 의미하지 않습니다.
      </p>
      <label>
        비교 문서
        <select
          {...form.register('document', {
            onChange: (): void => {
              form.setValue('oldClaim', '');
              form.setValue('newClaim', '');
            },
          })}
          disabled={disabled}
        >
          {baseline.documents.map((item: BasisDocument): JSX.Element => (
            <option key={item.document} value={item.document}>
              {item.document}
            </option>
          ))}
        </select>
      </label>
      <label>
        대응 분류
        <select
          {...form.register('disposition', {
            onChange: (): void => {
              form.setValue('oldClaim', '');
              form.setValue('newClaim', '');
            },
          })}
          disabled={disabled}
        >
          <option value="same">같음</option>
          <option value="changed">변경</option>
          <option value="missing">미발견</option>
          <option value="new">신규</option>
        </select>
      </label>
      {disposition !== 'new' && (
        <label>
          저장 당시 주장
          <select {...form.register('oldClaim')} disabled={disabled}>
            <option value="">이전 주장 선택</option>
            {old?.knowledge.claims.map((claim: KnowledgeClaim): JSX.Element => (
              <option key={claim.claim_id} value={claim.claim_id}>
                {claimLabel(claim.reviewed_value).slice(0, 250)} ·{' '}
                {claim.decision}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className={styles.error}>{form.formState.errors.oldClaim?.message}</p>
      {disposition !== 'missing' && (
        <label>
          이번에 준비한 주장
          <select {...form.register('newClaim')} disabled={disabled}>
            <option value="">새 주장 선택</option>
            {fresh?.knowledge.claims.map(
              (claim: KnowledgeClaim): JSX.Element => (
                <option key={claim.claim_id} value={claim.claim_id}>
                  {claimLabel(claim.reviewed_value).slice(0, 250)} ·{' '}
                  {claim.decision}
                </option>
              ),
            )}
          </select>
        </label>
      )}
      <p className={styles.error}>{form.formState.errors.newClaim?.message}</p>
      <label>
        대응 이유
        <textarea
          {...form.register('reason')}
          disabled={disabled}
          rows={2}
          maxLength={1000}
        />
      </label>
      <p className={styles.error}>{form.formState.errors.reason?.message}</p>
      <Button type="submit" variant="secondary" disabled={disabled}>
        선택한 대응 추가
      </Button>
    </form>
  );
}

type ComparisonCreateFormProps = PersonalFormActions & {
  onCancel: () => void;
  onSaved: () => void;
};
/** 실제 불변 결과와 같은 문서 범위의 현재 스냅샷을 준비해 개인 비교를 만듭니다. */
export function ComparisonCreateForm({
  session,
  blocked,
  onMutate,
  onError,
  onInspect,
  onCancel,
  onSaved,
}: ComparisonCreateFormProps): JSX.Element {
  const form = useForm<ComparisonFormValues>({
    resolver: zodResolver(comparisonFormSchema),
    defaultValues: { title: '', baselineId: '' },
  });
  const [page, setPage] = useState<PersonalPage | null>(null);
  const [baseline, setBaseline] = useState<RecordEnvelope | null>(null);
  const [current, setCurrent] = useState<PersonalBasis | null>(null);
  const [mappings, setMappings] = useState<ClaimMapping[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [index, setIndex] = useState(0);
  const life = useRef(0);
  const selectedLife = useRef(0);
  const oldBasis = baseline ? readBasis(baseline.record.data.basis) : null;
  /** 저장 결과 목록의 현재 페이지를 실제 cursor로 읽습니다. */
  async function load(cursor: string | null): Promise<void> {
    const stamp = ++life.current;
    const result = await listPersonal('savedResults', session, cursor);
    if (stamp !== life.current) return;
    if (result.ok) setPage(result.data);
    else {
      setError(result.error.message);
      onError(result.error);
    }
  }
  useEffect((): (() => void) => {
    const stamp = ++life.current;
    void listPersonal('savedResults', session, null).then(
      (result: Awaited<ReturnType<typeof listPersonal>>): void => {
        if (stamp !== life.current) return;
        if (result.ok) setPage(result.data);
        else {
          setError(result.error.message);
          onError(result.error);
        }
      },
    );
    return (): void => {
      life.current += 1;
      selectedLife.current += 1;
    };
  }, [session, onError]);
  /** 불변 결과 단건 응답의 실제 전체 기준을 비교의 출발점으로 사용합니다. */
  async function select(id: string): Promise<void> {
    const stamp = ++selectedLife.current;
    setBaseline(null);
    setCurrent(null);
    setMappings([]);
    setError('');
    if (!id) return;
    const result = await readPersonal('savedResults', id, session);
    if (stamp !== selectedLife.current) return;
    if (result.ok) {
      setBaseline(result.data);
      const basis = readBasis(result.data.record.data.basis);
      if (basis) onInspect(basis, '이전 결과의 저장 당시 기준');
      else setError('이 결과의 전체 기준을 읽을 수 없습니다.');
    } else {
      setError(result.error.message);
      onError(result.error);
    }
  }
  /** 이전 결과와 정확히 같은 명시 문서 범위로만 현재 준비 API를 호출합니다. */
  async function prepare(): Promise<void> {
    if (!oldBasis || oldBasis.documents.length === 0) return;
    const stamp = selectedLife.current;
    setLoading(true);
    setError('');
    const result = await preparePersonalContext(
      contextForBasis(oldBasis),
      session,
    );
    if (stamp !== selectedLife.current) return;
    setLoading(false);
    if (result.ok) {
      const expected = oldBasis.documents
        .map((item: BasisDocument): string => item.document)
        .sort()
        .join('\n');
      const actual = result.data.documents
        .map((item: BasisDocument): string => item.document)
        .sort()
        .join('\n');
      if (expected !== actual) {
        setError('준비 응답의 문서 범위가 이전 결과와 다릅니다.');
        return;
      }
      setCurrent(result.data);
      setMappings([]);
      onInspect(result.data, '비교 저장 전 현재 준비 조회');
    } else {
      setError(result.error.message);
      onError(result.error);
    }
  }
  /** 대응은 사용자가 명시한 ID와 이유만 전송하며 서버가 실제 저장 기준을 다시 보존합니다. */
  async function submit(values: ComparisonFormValues): Promise<void> {
    if (
      !baseline ||
      baseline.record.id !== values.baselineId ||
      !oldBasis ||
      !current
    )
      return;
    const requestId = newRequestId();
    const result = await onMutate(
      {
        connectionId: session.connectionId,
        operation: 'createComparison',
        input: {
          request_id: requestId,
          title: values.title,
          baseline_result_id: baseline.record.id,
          context_request: contextForBasis(oldBasis),
          mappings,
        },
      },
      { kind: 'comparisons', requestId },
    );
    if (result) onSaved();
  }
  return (
    <div className={styles.editor}>
      <h2>저장 결과·현재 근거 비교</h2>
      <p className={styles.muted}>
        같은 문서 범위에서 실제 주장을 직접 대응합니다. 자동 의미 평가·검토
        승인을 수행하지 않습니다.
      </p>
      <form className={styles.form} onSubmit={form.handleSubmit(submit)}>
        <label>
          비교 제목
          <input
            {...form.register('title')}
            maxLength={200}
            disabled={blocked}
          />
        </label>
        <p className={styles.error}>{form.formState.errors.title?.message}</p>
        <label>
          이전 저장 결과
          <select
            {...form.register('baselineId')}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
              form.setValue('baselineId', event.currentTarget.value, {
                shouldValidate: true,
              });
              void select(event.currentTarget.value);
            }}
            disabled={blocked || loading}
          >
            <option value="">실제 저장 결과 선택</option>
            {baseline &&
              !page?.items.some(
                (item: PersonalPage['items'][number]): boolean =>
                  item.id === baseline.record.id,
              ) && (
                <option value={baseline.record.id}>
                  {textValue(baseline.record.data, 'title')} (선택한 결과)
                </option>
              )}
            {page?.items.map(
              (item: PersonalPage['items'][number]): JSX.Element => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.created_at}
                </option>
              ),
            )}
          </select>
        </label>
        <p className={styles.error}>
          {form.formState.errors.baselineId?.message}
        </p>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={index < 1 || blocked}
            onClick={(): void => {
              setIndex(index - 1);
              void load(cursors[index - 1] || null);
            }}
          >
            결과 이전
          </Button>
          <span>{index + 1}쪽</span>
          <Button
            variant="secondary"
            disabled={!page?.next_cursor || blocked}
            onClick={(): void => {
              const cursor = page?.next_cursor;
              if (!cursor) return;
              setCursors([...cursors.slice(0, index + 1), cursor]);
              setIndex(index + 1);
              void load(cursor);
            }}
          >
            결과 다음
          </Button>
        </div>
        {page && (page.truncated || page.skipped.length > 0) && (
          <p className={styles.warning}>일부 저장 결과를 읽지 못했습니다.</p>
        )}
        {oldBasis && (
          <>
            <p>
              동일 비교 범위:{' '}
              {oldBasis.documents
                .map((item: BasisDocument): string => item.document)
                .join(', ') || '위키 문서 없음'}
            </p>
            <Button
              variant="secondary"
              disabled={blocked || loading || oldBasis.documents.length === 0}
              onClick={(): void => {
                void prepare();
              }}
            >
              {loading ? '현재 기준 준비 중…' : '동일 범위의 현재 기준 준비'}
            </Button>
          </>
        )}
        {error && <StatusNotice tone="warning">{error}</StatusNotice>}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={blocked} onClick={onCancel}>
            초안 닫기
          </Button>
          <Button
            type="submit"
            disabled={
              blocked ||
              !current ||
              !session.permissions.includes('comparison_write')
            }
          >
            대응 {mappings.length}개로 비교 저장
          </Button>
        </div>
      </form>
      {oldBasis && current && (
        <>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={(): void =>
                onInspect(oldBasis, '이전 결과의 저장 당시 기준')
              }
            >
              이전 기준 보기
            </Button>
            <Button
              variant="secondary"
              onClick={(): void => onInspect(current, '현재 준비 조회')}
            >
              준비 기준 보기
            </Button>
          </div>
          <MappingBuilder
            key={`${baseline?.record.id}:${current.snapshot_revision}`}
            baseline={oldBasis}
            current={current}
            disabled={blocked || mappings.length >= 100}
            onAdd={(mapping: ClaimMapping): void =>
              setMappings((items: ClaimMapping[]): ClaimMapping[] => [
                ...items,
                mapping,
              ])
            }
          />
          <MappingCards
            mappings={mappings}
            baseline={oldBasis}
            current={current}
            onRemove={
              blocked
                ? undefined
                : (indexToRemove: number): void =>
                    setMappings((items: ClaimMapping[]): ClaimMapping[] =>
                      items.filter(
                        (_item: ClaimMapping, itemIndex: number): boolean =>
                          itemIndex !== indexToRemove,
                      ),
                    )
            }
          />
        </>
      )}
    </div>
  );
}

type MappingCardsProps = {
  mappings: ClaimMapping[];
  baseline: PersonalBasis | null;
  current: PersonalBasis | null;
  onRemove?: (index: number) => void;
};
/** 비교에 실제 저장된 사용자 대응과 이전·새 주장 내용을 함께 보여 줍니다. */
export function MappingCards({
  mappings,
  baseline,
  current,
  onRemove,
}: MappingCardsProps): JSX.Element {
  return (
    <div className={styles.mappingCards}>
      {mappings.length === 0 && (
        <p className={styles.muted}>
          명시한 주장 대응이 없습니다. 전체 문서가 같거나 모두 검토됐다는 뜻은
          아닙니다.
        </p>
      )}
      {mappings.map((mapping: ClaimMapping, index: number): JSX.Element => {
        const old = baseline?.documents
          .find(
            (document: BasisDocument): boolean =>
              document.document === mapping.document,
          )
          ?.knowledge.claims.find(
            (claim: KnowledgeClaim): boolean =>
              claim.claim_id === mapping.old_claim_id,
          );
        const fresh = current?.documents
          .find(
            (document: BasisDocument): boolean =>
              document.document === mapping.document,
          )
          ?.knowledge.claims.find(
            (claim: KnowledgeClaim): boolean =>
              claim.claim_id === mapping.new_claim_id,
          );
        const label =
          mapping.disposition === 'same'
            ? '같음'
            : mapping.disposition === 'changed'
              ? '변경'
              : mapping.disposition === 'missing'
                ? '미발견'
                : '신규';
        return (
          <article
            key={`${mapping.document}:${mapping.old_claim_id}:${mapping.new_claim_id}:${index}`}
            className={styles.mapping}
          >
            <header>
              <strong>{label}</strong>
              <span>{mapping.document}</span>
              {onRemove && (
                <Button
                  variant="secondary"
                  onClick={(): void => onRemove(index)}
                >
                  대응 삭제
                </Button>
              )}
            </header>
            <div className={styles.sideBySide}>
              <div>
                <small>이전 결과의 기준</small>
                <p>
                  {old
                    ? claimLabel(old.reviewed_value)
                    : '대응하는 이전 주장 없음'}
                </p>
              </div>
              <div>
                <small>비교 생성 당시 기준</small>
                <p>
                  {fresh
                    ? claimLabel(fresh.reviewed_value)
                    : '대응하는 새 주장 없음'}
                </p>
              </div>
            </div>
            <p>이유: {mapping.reason}</p>
            <details>
              <summary>전체 대응·조건·인용</summary>
              <pre>
                {jsonText({
                  mapping,
                  old: old || null,
                  current: fresh || null,
                })}
              </pre>
            </details>
          </article>
        );
      })}
    </div>
  );
}

type ComparisonCompletionProps = PersonalFormActions & {
  comparison: RecordEnvelope;
  current: PersonalBasis;
  mappings: ClaimMapping[];
};
/** 실제 검토 상태를 조회한 주장만 지정하고 서버가 확인하는 완료 이벤트를 기록합니다. */
export function ComparisonCompletion({
  session,
  blocked,
  onMutate,
  onError,
  comparison,
  current,
  mappings,
}: ComparisonCompletionProps): JSX.Element {
  const form = useForm<CompletionFormValues>({
    resolver: zodResolver(completionFormSchema),
    defaultValues: { outcome: 'deferred', reason: '', selected: [] },
  });
  const [eligible, setEligible] = useState<ClaimSelection[]>([]);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const life = useRef(0);
  useEffect(
    (): (() => void) => (): void => {
      life.current += 1;
    },
    [],
  );
  const mapped = mappings.filter(
    (mapping: ClaimMapping): boolean =>
      typeof mapping.new_claim_id === 'string',
  );
  const outcome = useWatch({ control: form.control, name: 'outcome' });
  const chosen = useWatch({ control: form.control, name: 'selected' });
  /** 승인·정정·거절의 실제 현재 검토 판본을 조회해 선택지를 만듭니다. */
  async function check(): Promise<void> {
    const stamp = ++life.current;
    setLoading(true);
    setError('');
    const result = await currentReviewedClaims(current, session);
    if (stamp !== life.current) return;
    setLoading(false);
    if (result.ok) {
      setEligible(
        result.data.filter((selection: ClaimSelection): boolean =>
          mapped.some(
            (mapping: ClaimMapping): boolean =>
              mapping.document === selection.document &&
              mapping.new_claim_id === selection.claim_id,
          ),
        ),
      );
      setChecked(true);
      form.setValue('selected', []);
    } else {
      setError(result.error.message);
      onError(result.error);
      setChecked(false);
    }
  }
  /** 조회된 실제 참조만 제출하고 비교 기록의 편집 시작 판본을 자동 교체하지 않습니다. */
  async function submit(values: CompletionFormValues): Promise<void> {
    const reviewedClaims = eligible.filter(
      (selection: ClaimSelection): boolean =>
        values.selected.includes(`${selection.document}:${selection.claim_id}`),
    );
    if (
      values.outcome === 'reviewed' &&
      (!checked ||
        mapped.length === 0 ||
        !mapped.every((mapping: ClaimMapping): boolean =>
          reviewedClaims.some(
            (selection: ClaimSelection): boolean =>
              selection.document === mapping.document &&
              selection.claim_id === mapping.new_claim_id,
          ),
        ))
    ) {
      setError(
        '검토 완료는 대응한 모든 새 주장에 실제 승인·정정·거절 검토가 확인되어야 합니다. 현재 검토 상태를 조회하고 선택해 주세요.',
      );
      return;
    }
    const requestId = newRequestId();
    await onMutate(
      {
        connectionId: session.connectionId,
        operation: 'completeComparison',
        input: {
          record_id: comparison.record.id,
          request_id: requestId,
          expected_revision: comparison.revision,
          outcome: values.outcome,
          reason: values.reason,
          reviewed_claims: reviewedClaims,
        },
      },
      { kind: 'comparisons', requestId, recordId: comparison.record.id },
    );
  }
  return (
    <form className={styles.form} onSubmit={form.handleSubmit(submit)}>
      <h3>비교 완료 기록</h3>
      <p className={styles.notice}>
        대응한 주장만 검토 범위입니다. 원문 검토 화면에서 기록된
        승인·정정·거절을 서버가 확인하며 다른 주장을 승인하지 않습니다.
      </p>
      <Button
        variant="secondary"
        disabled={blocked || loading}
        onClick={(): void => {
          void check();
        }}
      >
        {loading
          ? '현재 검토 상태 확인 중…'
          : '대응 주장의 실제 검토 상태 조회'}
      </Button>
      {checked && eligible.length === 0 && (
        <p>
          현재 완료에 사용할 수 있는 검토 주장이 없습니다. 보류로 기록할 수
          있습니다.
        </p>
      )}
      {eligible.map((selection: ClaimSelection): JSX.Element => {
        const claim = current.documents
          .find(
            (document: BasisDocument): boolean =>
              document.document === selection.document,
          )
          ?.knowledge.claims.find(
            (item: KnowledgeClaim): boolean =>
              item.claim_id === selection.claim_id,
          );
        const key = `${selection.document}:${selection.claim_id}`;
        return (
          <label className={styles.check} key={key}>
            <input
              type="checkbox"
              value={key}
              {...form.register('selected')}
              disabled={blocked}
            />
            <span>
              {selection.document} ·{' '}
              {claim ? claimLabel(claim.reviewed_value) : '선택한 실제 주장'}
            </span>
          </label>
        );
      })}
      <label>
        완료 상태
        <select {...form.register('outcome')} disabled={blocked}>
          <option value="deferred">보류</option>
          <option value="reviewed">명시 대응 주장 검토 완료</option>
        </select>
      </label>
      <label>
        완료·보류 이유
        <textarea
          {...form.register('reason')}
          rows={3}
          maxLength={1000}
          disabled={blocked}
        />
      </label>
      <p className={styles.error}>{form.formState.errors.reason?.message}</p>
      {error && <StatusNotice tone="warning">{error}</StatusNotice>}
      <Button
        type="submit"
        disabled={
          blocked ||
          !session.permissions.includes('comparison_write') ||
          (outcome === 'reviewed' && chosen.length === 0)
        }
      >
        비교 완료 이벤트 기록
      </Button>
    </form>
  );
}

/** 서버에 저장된 대응 목록만 검증해 사람이 읽는 카드에 사용합니다. */
export function readMappings(value: KnowledgeValue): ClaimMapping[] {
  const result = z
    .array(
      z.object({
        document: z.string(),
        old_claim_id: z.string().nullable().optional(),
        new_claim_id: z.string().nullable().optional(),
        disposition: z.enum(['same', 'changed', 'missing', 'new']),
        reason: z.string(),
      }),
    )
    .safeParse(value.mappings);
  return result.success ? result.data : [];
}
