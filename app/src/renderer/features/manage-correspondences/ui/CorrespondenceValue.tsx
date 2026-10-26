import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, ReactNode } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { KnowledgeJson } from '@contracts/knowledge.contract';
import { readAnchorDocument } from '../api/correspondences.api';
import type {
  Anchor,
  CorrespondenceValue,
  Failure,
  Scope,
} from '../model/correspondence.schema';
import { emptyValue, stateLabel } from '../model/correspondence.schema';
import styles from './ManageCorrespondences.module.scss';

const labels: Record<string, string> = {
  statement: '대응 문장',
  direction: '연결 방향',
  condition: '조건 쪽 원문',
  concept: '개념 쪽 원문',
  document: '문서',
  source_revision: '원문 판본',
  quote: '인용',
  start_line: '시작 줄',
  end_line: '끝 줄',
  occurrence: '같은 구절 순서',
  qualifiers: '수량·조건·예외',
  quantity: '수량',
  status: '확인 상태',
  expression: '수량 설명',
  subject: '수량 대상',
  unit: '단위',
  lower: '하한',
  upper: '상한',
  lower_inclusive: '하한 포함',
  upper_inclusive: '상한 포함',
  conditions: '추가 조건',
  exceptions: '예외',
  items: '항목',
  business_scope: '업무 적용 범위',
  axes: '범위 항목',
  name: '범위 이름',
  value: '내용',
  source: '근거',
  validity: '적용 기간',
  start: '시작 시각',
  end: '종료 시각',
  timezone: '시간대',
  start_inclusive: '시작 포함',
  end_inclusive: '종료 포함',
  basis: '연결 자체의 근거',
  kind: '근거 종류',
  reason: '이유',
  link_evidence: '연결을 정의한 인용',
  questions: '확인 질문',
  references: '의존 참조',
  related_to: '참고 선례',
  before: '변경 전',
  after: '변경 후',
  actor: '작성 주체',
  timestamp: '작성 시각',
  action: '행동',
  decision: '판단',
  applicability: '현재 적용',
  reasons: '적용 사유',
  conflict_refs: '상충 판단',
};
type DetailsProps = { value: KnowledgeJson };
/** 원래의 전체 한정어·참조·이력 값을 생략 없이 펼쳐 표시합니다. */
export function CorrespondenceDetails({ value }: DetailsProps): JSX.Element {
  if (value === null) return <span className={styles.muted}>미지정</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol className={styles.values}>
        {value.map((item: KnowledgeJson, index: number): JSX.Element => (
          <li key={index}>
            <CorrespondenceDetails value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span className={styles.muted}>등록 항목 없음</span>
    );
  if (typeof value === 'object')
    return (
      <dl className={styles.values}>
        {Object.entries(value).map(
          ([key, item]: [string, KnowledgeJson]): JSX.Element => (
            <div key={key}>
              <dt>{labels[key] || key}</dt>
              <dd>
                <CorrespondenceDetails value={item} />
              </dd>
            </div>
          ),
        )}
      </dl>
    );
  const text =
    typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value);
  return <span>{stateLabel(text)}</span>;
}
type AnchorEditorProps = {
  title: string;
  value: Anchor;
  scope: Scope;
  fixedDocument?: boolean;
  onChange: (value: Anchor) => void;
  onInvalidated: (error: Failure) => void;
};
/** 사용자가 읽은 원문의 판본을 인용에 결합하고 이전 비동기 응답을 폐기합니다. */
function AnchorEditor({
  title,
  value,
  scope,
  fixedDocument = false,
  onChange,
  onInvalidated,
}: AnchorEditorProps): JSX.Element {
  const [source, setSource] = useState<{
    document: string;
    revision: string;
    content: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  useEffect((): (() => void) => {
    generation.current += 1;
    return (): void => {
      generation.current += 1;
    };
  }, [value.document, scope]);
  /** 원문 읽기는 인용을 자동 선택하거나 기존 graph 참조를 지우지 않습니다. */
  async function load(): Promise<void> {
    const stamp = generation.current;
    setLoading(true);
    setError('');
    const result = await readAnchorDocument(scope, value.document);
    if (stamp !== generation.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      onInvalidated(result.error);
      return;
    }
    setSource(result.data);
    onChange({ ...value, source_revision: result.data.revision });
  }
  return (
    <fieldset className={styles.fields} disabled={loading}>
      <legend>{title}</legend>
      <TextField
        label={`${title} 문서 경로`}
        value={value.document}
        readOnly={fixedDocument}
        onChange={(event: ChangeEvent<HTMLInputElement>): void =>
          onChange({
            ...value,
            document: event.target.value,
            source_revision: '',
          })
        }
      />
      <Button
        variant="secondary"
        onClick={(): void => {
          void load();
        }}
        disabled={!value.document}
      >
        {loading ? '원문 읽는 중…' : `${title} 현재 원문 읽기`}
      </Button>
      {error && <StatusNotice tone="error">{error}</StatusNotice>}
      <small className={styles.muted}>
        {value.source_revision
          ? '인용할 판본이 지정되어 있습니다. 인용과 줄 번호를 대조해 주세요.'
          : '원문을 먼저 읽어 인용할 판본을 확인하세요.'}
      </small>
      {value.source_revision && (
        <details>
          <summary>인용 판본 확인</summary>
          <p className={styles.muted}>{value.source_revision}</p>
        </details>
      )}
      {source &&
        source.document === value.document &&
        source.revision === value.source_revision && (
          <details>
            <summary>읽은 원문 전체 · 줄 번호</summary>
            <pre className={styles.source}>
              {source.content
                .split('\n')
                .map(
                  (line: string, index: number): string =>
                    `${index + 1}  ${line}`,
                )
                .join('\n')}
            </pre>
          </details>
        )}
      <TextareaField
        label={`${title} 정확한 인용`}
        value={value.quote}
        maxLength={1000}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
          onChange({ ...value, quote: event.target.value })
        }
      />
      <div className={styles.two}>
        <TextField
          type="number"
          min={1}
          label={`${title} 시작 줄`}
          value={value.start_line}
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            onChange({ ...value, start_line: Number(event.target.value) })
          }
        />
        <TextField
          type="number"
          min={value.start_line}
          label={`${title} 끝 줄`}
          value={value.end_line}
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            onChange({ ...value, end_line: Number(event.target.value) })
          }
        />
      </div>
      <TextField
        type="number"
        min={0}
        label={`${title} 같은 구절 순서 (0부터)`}
        value={value.occurrence ?? ''}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          const next = { ...value };
          if (event.target.value === '') delete next.occurrence;
          else next.occurrence = Number(event.target.value);
          onChange(next);
        }}
      />
    </fieldset>
  );
}
type ValueEditorProps = {
  value: CorrespondenceValue;
  scope: Scope;
  expert: boolean;
  existing: boolean;
  onChange: (value: CorrespondenceValue) => void;
  onInvalidated: (error: Failure) => void;
  children?: ReactNode;
};
/** 입력 항목 밖의 graph·이벤트 참조도 원형대로 보존하는 전체 값 편집기입니다. */
export function CorrespondenceValueEditor({
  value,
  scope,
  expert,
  existing,
  children,
  onChange,
  onInvalidated,
}: ValueEditorProps): JSX.Element {
  const quantity = value.qualifiers.quantity;
  const validity = value.business_scope.validity;
  /** 자유문장을 줄 단위로 보존하되 빈 줄을 근거로 만들지 않습니다. */
  function lines(text: string): string[] {
    return text.split('\n').filter((line: string): boolean => line.length > 0);
  }
  /** 한정어 하위 값만 바꾸고 나머지 참조를 그대로 유지합니다. */
  function changeQuantity(next: typeof quantity): void {
    onChange({ ...value, qualifiers: { ...value.qualifiers, quantity: next } });
  }
  /** 기간의 미확인·명시 무기한·실제 기간을 구별합니다. */
  function changeValidity(next: typeof validity): void {
    onChange({
      ...value,
      business_scope: { ...value.business_scope, validity: next },
    });
  }
  return (
    <div className={styles.editorColumns}>
      <section className={styles.editorPane} aria-label="조건과 적용 범위">
        <p className={styles.eyebrow}>A · 조건과 적용 범위</p>
        <AnchorEditor
          title="조건 쪽"
          value={value.condition}
          scope={scope}
          fixedDocument={existing}
          onInvalidated={onInvalidated}
          onChange={(anchor: Anchor): void =>
            onChange({ ...value, condition: anchor })
          }
        />
        <TextareaField
          label="대응 문장"
          rows={3}
          value={value.statement}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
            onChange({ ...value, statement: event.target.value })
          }
        />
        <SelectField
          label="연결 방향"
          value={value.direction}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
            onChange({
              ...value,
              direction:
                event.target.value === 'equivalent_definition'
                  ? 'equivalent_definition'
                  : 'condition_to_concept',
            })
          }
        >
          <option value="condition_to_concept">조건 → 개념</option>
          <option value="equivalent_definition">양방향 정의 (동치)</option>
        </SelectField>
        <fieldset className={styles.fields}>
          <legend>수량·조건·예외</legend>
          <SelectField
            label="수량 확인 상태"
            value={quantity.status}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              changeQuantity(
                event.target.value === 'specified'
                  ? {
                      ...quantity,
                      status: 'specified',
                      subject: '',
                      unit: '',
                      lower: '',
                      upper: '',
                      lower_inclusive: true,
                      upper_inclusive: true,
                    }
                  : {
                      status:
                        event.target.value === 'not_applicable'
                          ? 'not_applicable'
                          : 'unknown',
                      expression: quantity.expression,
                    },
              )
            }
          >
            <option value="unknown">미확인</option>
            <option value="not_applicable">수량 해당 없음</option>
            <option value="specified">수량 명시됨</option>
          </SelectField>
          <TextareaField
            label="수량 설명"
            value={quantity.expression}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
              changeQuantity({ ...quantity, expression: event.target.value })
            }
          />
          {quantity.status === 'specified' && (
            <div className={styles.two}>
              {['subject', 'unit', 'lower', 'upper'].map(
                (key: string): JSX.Element => (
                  <TextField
                    key={key}
                    label={labels[key]}
                    value={
                      typeof quantity[key] === 'string' ? quantity[key] : ''
                    }
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      changeQuantity({ ...quantity, [key]: event.target.value })
                    }
                  />
                ),
              )}
              {['lower_inclusive', 'upper_inclusive'].map(
                (key: string): JSX.Element => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={quantity[key] === true}
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        changeQuantity({
                          ...quantity,
                          [key]: event.target.checked,
                        })
                      }
                    />{' '}
                    {labels[key]}
                  </label>
                ),
              )}
            </div>
          )}
          {(['conditions', 'exceptions'] as const).map(
            (key: 'conditions' | 'exceptions'): JSX.Element => (
              <div className={styles.fields} key={key}>
                <SelectField
                  label={`${labels[key]} 확인 상태`}
                  value={value.qualifiers[key].status}
                  onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                    onChange({
                      ...value,
                      qualifiers: {
                        ...value.qualifiers,
                        [key]: {
                          ...value.qualifiers[key],
                          status: event.target.value,
                          items:
                            event.target.value === 'specified'
                              ? value.qualifiers[key].items
                              : [],
                        },
                      },
                    })
                  }
                >
                  <option value="unknown">미확인</option>
                  <option value="none">명시적으로 없음</option>
                  <option value="specified">명시됨</option>
                </SelectField>
                {value.qualifiers[key].status === 'specified' && (
                  <TextareaField
                    label={`${labels[key]} (한 줄에 하나)`}
                    value={value.qualifiers[key].items.join('\n')}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
                      onChange({
                        ...value,
                        qualifiers: {
                          ...value.qualifiers,
                          [key]: {
                            ...value.qualifiers[key],
                            items: lines(event.target.value),
                          },
                        },
                      })
                    }
                  />
                )}
              </div>
            ),
          )}
        </fieldset>
        <fieldset className={styles.fields}>
          <legend>업무 적용 범위</legend>
          {value.business_scope.axes.map(
            (
              axis: CorrespondenceValue['business_scope']['axes'][number],
              index: number,
            ): JSX.Element => {
              /** 선택한 업무 축만 명시 수정합니다. */
              function update(next: typeof axis): void {
                onChange({
                  ...value,
                  business_scope: {
                    ...value.business_scope,
                    axes: value.business_scope.axes.map(
                      (item: typeof axis, at: number): typeof axis =>
                        at === index ? next : item,
                    ),
                  },
                });
              }
              return (
                <div className={styles.fields} key={index}>
                  <TextField
                    label={`범위 ${index + 1} 이름`}
                    value={axis.name}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      update({ ...axis, name: event.target.value })
                    }
                  />
                  <SelectField
                    label={`범위 ${index + 1} 상태`}
                    value={axis.status}
                    onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                      update({
                        ...axis,
                        status:
                          event.target.value === 'specified'
                            ? 'specified'
                            : event.target.value === 'unrestricted'
                              ? 'unrestricted'
                              : 'unknown',
                        value:
                          event.target.value === 'specified'
                            ? axis.value || ''
                            : null,
                      })
                    }
                  >
                    <option value="unknown">미확인</option>
                    <option value="unrestricted">명시적으로 제한 없음</option>
                    <option value="specified">특정 범위</option>
                  </SelectField>
                  {axis.status === 'specified' && (
                    <TextField
                      label={`범위 ${index + 1} 값`}
                      value={axis.value || ''}
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        update({ ...axis, value: event.target.value })
                      }
                    />
                  )}
                  <TextField
                    label={`범위 ${index + 1} 근거`}
                    value={axis.source || ''}
                    onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                      update({ ...axis, source: event.target.value || null })
                    }
                  />
                  <Button
                    variant="secondary"
                    disabled={value.business_scope.axes.length <= 1}
                    onClick={(): void =>
                      onChange({
                        ...value,
                        business_scope: {
                          ...value.business_scope,
                          axes: value.business_scope.axes.filter(
                            (_item: typeof axis, at: number): boolean =>
                              at !== index,
                          ),
                        },
                      })
                    }
                  >
                    이 범위 제거
                  </Button>
                </div>
              );
            },
          )}
          <Button
            variant="secondary"
            disabled={value.business_scope.axes.length >= 50}
            onClick={(): void =>
              onChange({
                ...value,
                business_scope: {
                  ...value.business_scope,
                  axes: [
                    ...value.business_scope.axes,
                    { name: '', status: 'unknown', value: null, source: null },
                  ],
                },
              })
            }
          >
            범위 추가
          </Button>
          <SelectField
            label="적용 기간 상태"
            value={validity.status}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              changeValidity(
                event.target.value === 'specified'
                  ? {
                      status: 'specified',
                      source: validity.source,
                      start: '',
                      end: '',
                      timezone: 'Asia/Seoul',
                      start_inclusive: true,
                      end_inclusive: false,
                    }
                  : {
                      status:
                        event.target.value === 'unrestricted'
                          ? 'unrestricted'
                          : 'unknown',
                      source: validity.source,
                    },
              )
            }
          >
            <option value="unknown">미확인</option>
            <option value="unrestricted">명시적 무기한</option>
            <option value="specified">기간 지정</option>
          </SelectField>
          <TextField
            label="기간 근거"
            value={validity.source || ''}
            onChange={(event: ChangeEvent<HTMLInputElement>): void =>
              changeValidity({
                ...validity,
                source: event.target.value || null,
              })
            }
          />
          {validity.status === 'specified' && (
            <>
              {['start', 'end', 'timezone'].map((key: string): JSX.Element => (
                <TextField
                  key={key}
                  label={labels[key]}
                  description={
                    key !== 'timezone'
                      ? 'UTC offset 포함 · 예: 2026-10-25T09:00:00+09:00'
                      : 'IANA 시간대'
                  }
                  value={typeof validity[key] === 'string' ? validity[key] : ''}
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    changeValidity({ ...validity, [key]: event.target.value })
                  }
                />
              ))}
              {['start_inclusive', 'end_inclusive'].map(
                (key: string): JSX.Element => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={validity[key] === true}
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        changeValidity({
                          ...validity,
                          [key]: event.target.checked,
                        })
                      }
                    />{' '}
                    {labels[key]}
                  </label>
                ),
              )}
            </>
          )}
        </fieldset>
        {children}
      </section>
      <section className={styles.editorPane} aria-label="개념과 연결 근거">
        <p className={styles.eyebrow}>B · 개념과 연결 근거</p>
        <AnchorEditor
          title="개념 쪽"
          value={value.concept}
          scope={scope}
          fixedDocument={existing}
          onInvalidated={onInvalidated}
          onChange={(anchor: Anchor): void =>
            onChange({ ...value, concept: anchor })
          }
        />
        <fieldset className={styles.fields}>
          <legend>대응 자체의 근거</legend>
          <SelectField
            label="근거 종류"
            value={value.basis.kind}
            disabled={expert}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              onChange({
                ...value,
                basis: {
                  ...value.basis,
                  kind:
                    event.target.value === 'source' ? 'source' : 'candidate',
                  link_evidence:
                    event.target.value === 'source'
                      ? value.basis.link_evidence
                      : [],
                },
              })
            }
          >
            <option value="candidate">연결 후보 · 정의 미확인</option>
            <option value="source">원문이 연결을 정의함</option>
            {expert && <option value="expert">전문가 업무 판단</option>}
          </SelectField>
          <TextareaField
            label="연결 근거 설명"
            value={value.basis.reason}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
              onChange({
                ...value,
                basis: { ...value.basis, reason: event.target.value },
              })
            }
          />
          <p className={styles.muted}>
            {expert
              ? '판단 이벤트가 출처가 됩니다. 연결을 정의하는 원문 인용을 만들지 않습니다.'
              : '양끝점의 인용만으로 연결이 성립하지 않습니다. 연결을 정의한 구절은 별도로 추가하세요.'}
          </p>
          {value.basis.kind === 'source' && (
            <>
              {value.basis.link_evidence.map(
                (anchor: Anchor, index: number): JSX.Element => (
                  <section key={index}>
                    <AnchorEditor
                      title={`연결 근거 ${index + 1}`}
                      value={anchor}
                      scope={scope}
                      onInvalidated={onInvalidated}
                      onChange={(next: Anchor): void =>
                        onChange({
                          ...value,
                          basis: {
                            ...value.basis,
                            link_evidence: value.basis.link_evidence.map(
                              (item: Anchor, at: number): Anchor =>
                                at === index ? next : item,
                            ),
                          },
                        })
                      }
                    />
                    <Button
                      variant="secondary"
                      onClick={(): void =>
                        onChange({
                          ...value,
                          basis: {
                            ...value.basis,
                            link_evidence: value.basis.link_evidence.filter(
                              (_item: Anchor, at: number): boolean =>
                                at !== index,
                            ),
                          },
                        })
                      }
                    >
                      이 연결 근거 제거
                    </Button>
                  </section>
                ),
              )}
              <Button
                variant="secondary"
                disabled={value.basis.link_evidence.length >= 50}
                onClick={(): void =>
                  onChange({
                    ...value,
                    basis: {
                      ...value.basis,
                      link_evidence: [
                        ...value.basis.link_evidence,
                        emptyValue().condition,
                      ],
                    },
                  })
                }
              >
                연결 근거 추가
              </Button>
            </>
          )}
          <TextareaField
            label="확인 질문 (한 줄에 하나)"
            value={value.questions.join('\n')}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
              onChange({ ...value, questions: lines(event.target.value) })
            }
          />
        </fieldset>
        {(value.references.length > 0 || value.related_to.length > 0) && (
          <details>
            <summary>보존되는 의존 참조·참고 선례</summary>
            <CorrespondenceDetails
              value={{
                references: value.references,
                related_to: value.related_to,
              }}
            />
          </details>
        )}
      </section>
    </div>
  );
}

type AnchorViewProps = { title: string; anchor: Anchor };
/** 인용을 먼저 읽고 필요한 경우 당시 판본과 참조를 펼쳐 대조합니다. */
function AnchorView({ title, anchor }: AnchorViewProps): JSX.Element {
  return (
    <section className={styles.quoteCard}>
      <h3>{title}</h3>
      <p className={styles.muted}>
        {anchor.document} · {anchor.start_line}–{anchor.end_line}줄
      </p>
      <blockquote>{anchor.quote}</blockquote>
      <details>
        <summary>인용 판본·참조</summary>
        <CorrespondenceDetails value={anchor} />
      </details>
    </section>
  );
}
type ValueViewProps = { value: CorrespondenceValue };
/** 요약과 양끝점 근거를 대조하고 전체 한정어는 접힌 상세에 보존합니다. */
export function CorrespondenceValueView({
  value,
}: ValueViewProps): JSX.Element {
  const quantity = value.qualifiers.quantity;
  const validity = value.business_scope.validity;
  return (
    <div className={styles.valueView}>
      <section className={styles.summaryPane}>
        <p className={styles.eyebrow}>
          대응 내용 · {stateLabel(value.basis.kind)}
        </p>
        <h2 className={styles.statement}>{value.statement}</h2>
        <dl className={styles.summaryRows}>
          <div>
            <dt>연결 방향</dt>
            <dd>{stateLabel(value.direction)}</dd>
          </div>
          <div>
            <dt>수량</dt>
            <dd>
              {stateLabel(quantity.status)}
              {quantity.expression !== stateLabel(quantity.status)
                ? ` · ${quantity.expression}`
                : ''}
            </dd>
          </div>
          {(['conditions', 'exceptions'] as const).map(
            (key: 'conditions' | 'exceptions'): JSX.Element => (
              <div key={key}>
                <dt>{labels[key]}</dt>
                <dd>
                  {stateLabel(value.qualifiers[key].status)}
                  {value.qualifiers[key].items.map(
                    (item: string, index: number): JSX.Element => (
                      <p key={index}>{item}</p>
                    ),
                  )}
                </dd>
              </div>
            ),
          )}
          <div>
            <dt>업무 범위</dt>
            <dd>
              {value.business_scope.axes.map(
                (
                  axis: CorrespondenceValue['business_scope']['axes'][number],
                  index: number,
                ): JSX.Element => (
                  <p key={index}>
                    <strong>{axis.name}</strong> · {stateLabel(axis.status)}
                    {axis.value ? ` · ${axis.value}` : ''}
                    {axis.source && (
                      <small className={styles.rowSource}>{axis.source}</small>
                    )}
                  </p>
                ),
              )}
            </dd>
          </div>
          <div>
            <dt>적용 기간</dt>
            <dd>
              {stateLabel(validity.status)}
              {validity.status === 'specified' && (
                <CorrespondenceDetails value={validity} />
              )}
              {validity.source && (
                <small className={styles.rowSource}>{validity.source}</small>
              )}
            </dd>
          </div>
        </dl>
        <details>
          <summary>수량·조건·업무 범위 전체 값</summary>
          <CorrespondenceDetails
            value={{
              qualifiers: value.qualifiers,
              business_scope: value.business_scope,
            }}
          />
        </details>
        <details>
          <summary>의존 참조·참고 선례</summary>
          <CorrespondenceDetails
            value={{
              references: value.references,
              related_to: value.related_to,
            }}
          />
        </details>
      </section>
      <section className={styles.evidencePane} aria-label="양끝점과 연결 근거">
        <p className={styles.eyebrow}>원문 대조</p>
        <AnchorView title="A · 조건 쪽 원문" anchor={value.condition} />
        <AnchorView title="B · 개념 쪽 원문" anchor={value.concept} />
        <section className={styles.basisCard}>
          <h3>연결 자체의 근거 · {stateLabel(value.basis.kind)}</h3>
          <p>{value.basis.reason}</p>
          {value.basis.kind !== 'source' && (
            <StatusNotice
              tone={value.basis.kind === 'candidate' ? 'warning' : 'info'}
            >
              {value.basis.kind === 'candidate'
                ? '연결 정의가 확인되지 않은 후보입니다. 두 인용만으로 대응을 확정하지 않습니다.'
                : '전문가의 판단 기록이 출처입니다. 원문에 있는 정의와 구분합니다.'}
            </StatusNotice>
          )}
          {value.basis.link_evidence.map(
            (anchor: Anchor, index: number): JSX.Element => (
              <AnchorView
                key={index}
                title={`연결을 정의한 원문 ${index + 1}`}
                anchor={anchor}
              />
            ),
          )}
          {value.questions.length > 0 && (
            <div className={styles.questions}>
              <h3>확인할 질문</h3>
              <ul>
                {value.questions.map(
                  (question: string, index: number): JSX.Element => (
                    <li key={index}>{question}</li>
                  ),
                )}
              </ul>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
