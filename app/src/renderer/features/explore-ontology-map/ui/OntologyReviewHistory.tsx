import { useState } from 'react';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import type { JSX, SubmitEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type { CorrectionBasis, MapAssertion } from '../model/ontologyMap.types';
import type { DecisionCommand } from '../model/useOntologyDecision';
import { displayValue, valueObject } from '../model/buildOntologyGraph';
import styles from './OntologyMapWorkspace.module.scss';
import { OntologyValue } from './OntologyValue';
import {
  ontologyClaimLabel,
  ontologyProvenanceValue,
  ontologyRecordedEntities,
} from '../model/ontologyLabels';

type OntologyReviewHistoryProps = {
  assertion: MapAssertion;
  basis?: CorrectionBasis;
  blocked?: boolean;
  onSubmit?: (command: DecisionCommand) => Promise<void>;
};
const schema = z.object({
  reason: z.string().trim().min(1, '되돌림 이유를 입력해 주세요.').max(1000),
});
type UndoValues = z.infer<typeof schema>;
const actions: Record<string, string> = {
  accept: '원문 대조 확인',
  edit: '원문 근거 정정',
  reject: '거절',
  defer: '보류',
  undo: '원문 검토 되돌림',
  policy: '업무 판단',
  policy_undo: '전문가 판단 되돌림',
  relation_create: '새 관계 추가',
  relation_undo: '관계 추가 되돌림',
};

/** 검토 이유·주장·적용 범위를 읽고 현재·다른 관점·과거 판단을 구분합니다. */
export function OntologyReviewHistory({
  assertion,
  basis,
  blocked,
  onSubmit,
}: OntologyReviewHistoryProps): JSX.Element {
  const [limit, setLimit] = useState(20);
  const [all, setAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const form = useForm<UndoValues>({
    resolver: zodResolver(schema),
    defaultValues: { reason: '' },
  });
  const knowledge = assertion.knowledge;
  const events = [...knowledge.history, ...(knowledge.relationHistory ?? [])]
    .sort((left: KnowledgeValue, right: KnowledgeValue): number =>
      displayValue(left.timestamp).localeCompare(displayValue(right.timestamp)),
    )
    .filter(
      (event: KnowledgeValue): boolean =>
        all || event.claim_id === assertion.claim?.claim_id,
    )
    .toReversed();
  const selected = events.find(
    (event: KnowledgeValue): boolean => event.id === selectedId,
  );
  const recordedConcepts = ontologyRecordedEntities(selected).flatMap(
    (item: KnowledgeJson): KnowledgeValue[] => {
      const entity = valueObject(item);
      if (!entity) return [];
      const fields = Object.fromEntries(
        Object.entries(entity).filter(
          ([key]: [string, KnowledgeJson]): boolean =>
            !['id', 'status', 'provenance'].includes(key),
        ),
      );
      const provenance = ontologyProvenanceValue(
        entity.provenance,
        ontologyRecordedEntities(selected),
      );
      if (provenance) fields.provenance = provenance;
      return [fields];
    },
  );
  const addition =
    selected?.action === 'relation_create' ||
    selected?.action === 'relation_undo';
  const policy =
    selected?.kind === 'policy' ||
    selected?.action === 'policy' ||
    selected?.action === 'policy_undo';
  const eventScope = valueObject(selected?.scope);
  const sameScope =
    !policy ||
    (eventScope?.domain === knowledge.access.domain &&
      eventScope?.viewpoint === knowledge.access.viewpoint);
  const current =
    selected?.source_revision === knowledge.sourceRevision &&
    selected?.graph_revision === knowledge.graphRevision &&
    selected?.history_revision === knowledge.historyRevision &&
    knowledge.status === 'ready';
  const latest = addition
    ? knowledge.authoredRelations?.find(
        (item: KnowledgeValue): boolean =>
          item.claim_id === selected?.claim_id && item.status === 'active',
      )?.event_id
    : policy
      ? knowledge.policies.find(
          (item: KnowledgeValue): boolean =>
            item.claim_id === selected?.claim_id &&
            valueObject(item.scope)?.domain === knowledge.access.domain &&
            valueObject(item.scope)?.viewpoint === knowledge.access.viewpoint,
        )?.event_id
      : knowledge.claims.find(
          (item: (typeof knowledge.claims)[number]): boolean =>
            item.claim_id === selected?.claim_id,
        )?.review_event_id;
  const canUndo =
    !!basis &&
    !!onSubmit &&
    !blocked &&
    current &&
    sameScope &&
    typeof selected?.id === 'string' &&
    latest === selected.id &&
    basis.scope.permissions.includes(
      policy ? 'ontology_policy' : 'ontology_review',
    );
  /** 마지막 이벤트만 현재 읽은 판본에서 역이벤트로 기록합니다. */
  async function undo(values: UndoValues): Promise<void> {
    if (!canUndo || !basis || !onSubmit || typeof selected?.id !== 'string')
      return;
    const input = {
      document: assertion.document,
      event_id: selected.id,
      expected_state_revision: knowledge.stateRevision,
      reason: values.reason,
    };
    if (addition) {
      const {
        permissions: _permissions,
        connectionId,
        ...expectedScope
      } = basis.scope;
      await onSubmit({
        connectionId,
        expectedScope,
        operation: 'relationUndo',
        input: {
          ...input,
          request_id: crypto.randomUUID().replaceAll('-', ''),
          kind: policy ? 'policy' : 'source',
        },
      });
    } else
      await onSubmit({
        connectionId: basis.scope.connectionId,
        operation: policy ? 'policyUndo' : 'reviewUndo',
        input,
      });
  }
  return (
    <WorkspaceSection title="검토 기록" headingLevel={3}>
      <label>
        <input
          type="checkbox"
          checked={all}
          onChange={(): void => {
            setAll(!all);
            setLimit(20);
            setSelectedId(null);
          }}
        />
        문서 전체 기록 보기
      </label>
      <p className={styles.muted}>
        Clean Up 이전 기록도 보존된 원장에서 표시합니다. 문서{' '}
        {assertion.document}
      </p>
      {events.length === 0 && <p>이 범위에 검토 기록이 없습니다.</p>}
      {events.slice(0, limit).map((event: KnowledgeValue): JSX.Element => {
        const actor = valueObject(event.actor);
        const past =
          event.source_revision !== knowledge.sourceRevision ||
          event.graph_revision !== knowledge.graphRevision ||
          event.history_revision !== knowledge.historyRevision ||
          knowledge.status !== 'ready';
        const scope = valueObject(event.scope);
        const other =
          (event.kind === 'policy' ||
            event.action === 'policy' ||
            event.action === 'policy_undo') &&
          scope &&
          (scope.domain !== knowledge.access.domain ||
            scope.viewpoint !== knowledge.access.viewpoint);
        return (
          <button
            className={styles.attribute}
            aria-pressed={selectedId === event.id}
            type="button"
            key={displayValue(event.id)}
            onClick={(): void =>
              setSelectedId(typeof event.id === 'string' ? event.id : null)
            }
          >
            <strong>
              {actions[displayValue(event.action)] ||
                displayValue(event.action)}
              {past
                ? ' · 과거 근거'
                : other
                  ? ' · 다른 조회 기준'
                  : ' · 현재 근거'}
            </strong>
            <span>{displayValue(event.reason)}</span>
            <small>
              {displayValue(actor?.display_name) || '검토자'} ·{' '}
              {displayValue(event.timestamp)}
            </small>
          </button>
        );
      })}
      {events.length > limit && (
        <button type="button" onClick={(): void => setLimit(limit + 20)}>
          기록 더 보기 ({limit}/{events.length})
        </button>
      )}
      {selected && (
        <WorkspaceSection title="선택 기록" headingLevel={4}>
          <p>
            {current
              ? sameScope
                ? '현재 근거·조회 기준'
                : '다른 조회 기준의 판단'
              : '과거 근거의 판단 · 현재에 자동 적용하지 않음'}
          </p>
          <dl className={styles.fields}>
            <div>
              <dt>이유</dt>
              <dd>{displayValue(selected.reason)}</dd>
            </div>
            <div>
              <dt>작성자</dt>
              <dd>
                {displayValue(valueObject(selected.actor)?.display_name) ||
                  '검토자'}
              </dd>
            </div>
            <div>
              <dt>기록 시각</dt>
              <dd>{displayValue(selected.timestamp)}</dd>
            </div>
            {valueObject(selected.target)?.claim && (
              <div>
                <dt>당시 원문 주장</dt>
                <dd>
                  {eventValue(
                    selected,
                    'target',
                    current ? knowledge.effectiveGraph.entities : [],
                  )}
                </dd>
              </div>
            )}
            {eventScope && (
              <div>
                <dt>적용 범위</dt>
                <dd>
                  <OntologyValue
                    value={{
                      domain: eventScope.domain ?? null,
                      viewpoint: eventScope.viewpoint ?? null,
                    }}
                  />
                </dd>
              </div>
            )}
            <div>
              <dt>변경 전</dt>
              <dd>
                {eventValue(
                  selected,
                  'before',
                  current ? knowledge.effectiveGraph.entities : [],
                )}
              </dd>
            </div>
            <div>
              <dt>변경 후</dt>
              <dd>
                {eventValue(
                  selected,
                  'after',
                  current ? knowledge.effectiveGraph.entities : [],
                )}
              </dd>
            </div>
            {(['before_effective', 'after_effective'] as const).map(
              (
                phase: 'before_effective' | 'after_effective',
              ): JSX.Element | null =>
                selected[phase] ? (
                  <div key={phase}>
                    <dt>
                      {phase === 'before_effective'
                        ? '변경 전 적용된 관계'
                        : '변경 후 적용된 관계'}
                    </dt>
                    <dd>
                      {eventValue(
                        selected,
                        phase,
                        current ? knowledge.effectiveGraph.entities : [],
                      )}
                    </dd>
                  </div>
                ) : null,
            )}
          </dl>
          {recordedConcepts.length > 0 && (
            <details>
              <summary>당시 개념과 원문 정보</summary>
              <OntologyValue value={recordedConcepts} />
            </details>
          )}
          {basis && (
            <form
              className={styles.form}
              onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
                void form.handleSubmit(undo)(event);
              }}
            >
              <label>
                되돌림 이유
                <textarea
                  {...form.register('reason')}
                  disabled={!canUndo}
                  aria-invalid={!!form.formState.errors.reason}
                />
              </label>
              {form.formState.errors.reason && (
                <p role="alert">{form.formState.errors.reason.message}</p>
              )}
              <button type="submit" disabled={!canUndo}>
                선택 판단 되돌림 기록
              </button>
              {!canUndo && (
                <p className={styles.muted}>
                  현재 근거·조회 기준의 마지막 이벤트와 해당 권한을 확인한 경우
                  되돌릴 수 있습니다.
                </p>
              )}
            </form>
          )}
        </WorkspaceSection>
      )}
    </WorkspaceSection>
  );
}

/** 당시 이름으로 관계를 읽고 인용·조건·업무 값을 내부 참조 없이 모두 표시합니다. */
function eventValue(
  event: KnowledgeValue,
  phase: 'before' | 'after' | 'before_effective' | 'after_effective' | 'target',
  currentEntities: readonly KnowledgeJson[],
): JSX.Element {
  const addition =
    event.action === 'relation_create' || event.action === 'relation_undo';
  if (
    addition &&
    (phase === 'before' || phase === 'after') &&
    (event.action === 'relation_create') === (phase === 'before')
  )
    return <span>관계 추가 미적용</span>;
  const state = valueObject(event[phase]);
  const value =
    phase === 'target'
      ? valueObject(state?.claim)
      : addition
        ? valueObject(event.value)
        : valueObject(state?.value);
  if (!value) return <span>적용된 관계 없음</span>;
  const decision = displayValue(state?.decision);
  // 과거 기록은 당시 저장한 이름만 해석하며 현재 이름을 과거 사실로 대입하지 않습니다.
  const entities = [...ontologyRecordedEntities(event), ...currentEntities];
  const details = Object.fromEntries(
    Object.entries(value).filter(
      ([key]: [string, KnowledgeJson]): boolean =>
        ![
          'id',
          'status',
          'provenance',
          'subject',
          'predicate',
          'object',
          'property',
        ].includes(key),
    ),
  );
  const provenance = ontologyProvenanceValue(value.provenance, entities);
  if (provenance) details.provenance = provenance;
  for (const key of ['subject', 'object']) {
    const endpoint = valueObject(value[key]);
    if (endpoint)
      details[key] = Object.fromEntries(
        Object.entries(endpoint).filter(
          ([field]: [string, KnowledgeJson]): boolean =>
            !['kind', 'document', 'source_revision'].includes(field),
        ),
      );
  }
  const policy =
    event.kind === 'policy' ||
    event.action === 'policy' ||
    event.action === 'policy_undo';
  const decisionLabel =
    decision === 'active' || decision === 'policy'
      ? '업무 판단'
      : actions[decision] || (policy ? '업무 판단 미적용' : '미검토');
  return (
    <div>
      <p>
        {ontologyClaimLabel(value, entities)} ·{' '}
        {phase === 'target'
          ? '기록 당시 원문'
          : addition
            ? '추가 관계 적용'
            : decisionLabel}
      </p>
      {Object.keys(details).length > 0 && <OntologyValue value={details} />}
    </div>
  );
}
