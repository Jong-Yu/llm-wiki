import type { JSX } from 'react';
import { useWatch } from 'react-hook-form';
import type { UseFormReturn } from 'react-hook-form';
import type { KnowledgeEntity } from '@contracts/knowledge.contract';
import type { ReviewFormValues, ReviewLeaf } from '../model/ontologyReviewForm';
import {
  relationPredicateLabel,
  relationPredicates,
} from '../model/ontologyRelation.schema';

type OntologyAssertionFieldsProps = {
  leaves: ReviewLeaf[];
  form: UseFormReturn<ReviewFormValues>;
  entities: KnowledgeEntity[];
  lockContext?: boolean;
};
type AssertionFieldProps = Omit<OntologyAssertionFieldsProps, 'leaves'> & {
  leaf: ReviewLeaf;
};
const choices: Record<string, string[]> = {
  polarity: ['positive', 'negative'],
  modality: ['asserted', 'possible', 'capability', 'planned', 'hypothetical'],
  datatype: ['text', 'number'],
  predicate: relationPredicates,
};
const choiceLabels: Record<string, string> = {
  positive: '긍정',
  negative: '부정',
};

/** 선택지 값은 그대로 두고 보이는 이름만 확정 용어로 바꿉니다. */
function choiceLabel(
  field: string | number | undefined,
  value: string,
): string {
  return field === 'predicate'
    ? relationPredicateLabel(value)
    : (choiceLabels[value] ?? value);
}

/** 복합값의 구조를 유지하고 표시한 필드만 입력에 연결합니다. */
function AssertionField({
  leaf,
  form,
  entities,
  lockContext,
}: AssertionFieldProps): JSX.Element {
  const last = leaf.path.at(-1);
  const unset = useWatch({ control: form.control, name: `nulls.${leaf.id}` });
  const disabled =
    unset === true || (lockContext === true && leaf.path[0] === 'context');
  const input = form.register(`leaves.${leaf.id}`);
  const values = typeof last === 'string' ? choices[last] : undefined;
  const endpoint =
    leaf.kind === 'text' &&
    ((leaf.path.length === 1 && (last === 'subject' || last === 'object')) ||
      (leaf.path.length === 2 &&
        leaf.path[0] === 'provenance' &&
        (last === 'source_entity' || last === 'attributed_to')));
  return (
    <div>
      <label>
        {leaf.label}
        {endpoint ? (
          <select {...input} disabled={disabled}>
            <option value="">개념 선택</option>
            {leaf.value &&
              !entities.some(
                (entity: KnowledgeEntity): boolean => entity.id === leaf.value,
              ) && <option value={leaf.value}>이름을 확인할 개념</option>}
            {entities.map((entity: KnowledgeEntity): JSX.Element => (
              <option key={entity.id} value={entity.id}>
                {entity.label}
              </option>
            ))}
          </select>
        ) : values ? (
          <select {...input} disabled={disabled}>
            {!values.includes(leaf.value) && (
              <option value={leaf.value}>
                {choiceLabel(last, leaf.value)}
              </option>
            )}
            {values.map((value: string): JSX.Element => (
              <option key={value} value={value}>
                {choiceLabel(last, value)}
              </option>
            ))}
          </select>
        ) : (
          <textarea
            {...input}
            rows={last === 'evidence' ? 3 : 1}
            disabled={disabled}
          />
        )}
      </label>
      {leaf.kind === 'nullable' && (
        <label>
          <input
            type="checkbox"
            {...form.register(`nulls.${leaf.id}`)}
            disabled={lockContext === true && leaf.path[0] === 'context'}
          />
          미지정 유지
        </label>
      )}
    </div>
  );
}

/** 주어·목적어·조건·인용과 추가 출처 필드를 생략 없이 편집합니다. */
export function OntologyAssertionFields(
  props: OntologyAssertionFieldsProps,
): JSX.Element {
  // 내부 참조는 초안에 보존하며 사용자가 수정할 의미 필드만 표시합니다.
  const leaves = props.leaves.filter(
    (leaf: ReviewLeaf): boolean =>
      !['id', 'status', 'claim_id'].includes(String(leaf.path[0])) &&
      (leaf.path[0] !== 'provenance' ||
        ['source_entity', 'attributed_to', 'basis'].includes(
          String(leaf.path[1]),
        )),
  );
  const additional = leaves.filter(
    (leaf: ReviewLeaf): boolean => !leaf.primary,
  );
  return (
    <>
      {leaves
        .filter((leaf: ReviewLeaf): boolean => leaf.primary)
        .map((leaf: ReviewLeaf): JSX.Element => (
          <AssertionField key={leaf.id} {...props} leaf={leaf} />
        ))}
      {additional.length > 0 && (
        <details>
          <summary>추가 출처 정보</summary>
          {additional.map((leaf: ReviewLeaf): JSX.Element => (
            <AssertionField key={leaf.id} {...props} leaf={leaf} />
          ))}
        </details>
      )}
    </>
  );
}
