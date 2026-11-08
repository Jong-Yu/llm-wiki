import { useEffect, useId, useMemo, useRef } from 'react';
import type { JSX, SubmitEvent } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { ControllerRenderProps } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { documentDisplayName } from '@renderer/domains/documents';
import {
  documentTitleKey,
  useRouteTitles,
} from '@renderer/shared/lib/routeTitle';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import type { KnowledgeEntity } from '@contracts/knowledge.contract';
import type {
  CorrectionBasis,
  CorrectionReceipt,
} from '../model/ontologyMap.types';
import {
  relationSchema,
  relationDefaults,
  relationInput,
  relationPredicateLabel,
  relationPredicates,
} from '../model/ontologyRelation.schema';
import type { RelationValues } from '../model/ontologyRelation.schema';
import { useOntologyDecision } from '../model/useOntologyDecision';
import { ConceptPicker } from './ConceptPicker';
import type { ConceptOption } from './ConceptPicker';
import styles from './OntologyMapWorkspace.module.scss';
import panelStyles from './OntologyRelationPanel.module.scss';

type OntologyRelationPanelProps = {
  basis: CorrectionBasis;
  open: boolean;
  /** 열려 있는 동안 지도·목록에서 누른 개념을 빈 주체·대상 칸에 채우는 함수를 알립니다. */
  onPickerChange: (picker: ((entityId: string) => void) | null) => void;
  onSaved: (receipt: CorrectionReceipt) => void;
  onInvalidate: () => void;
  onDiscard: () => void;
  onChooseDocument?: () => void;
};

/** 새 관계는 주체·관계·대상·이유만 받아 전문가 의견으로 저장하며 원문 인용은 만들지 않습니다. 지도 오른쪽 패널에 들어갑니다. */
export function OntologyRelationPanel({
  basis,
  open,
  onPickerChange,
  onSaved,
  onInvalidate,
  onDiscard,
  onChooseDocument,
}: OntologyRelationPanelProps): JSX.Element {
  const errorId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const workspaceActive = useWorkspaceActivity();
  const form = useForm<RelationValues>({
    resolver: zodResolver(relationSchema),
    defaultValues: relationDefaults(),
  });
  const [subject, predicate, object, reason] = useWatch({
    control: form.control,
    name: ['subject', 'predicate', 'object', 'reason'],
  });
  // 주체·관계·대상·이유가 모두 채워졌을 때만 저장할 수 있습니다.
  const filled = !!subject && !!predicate && !!object && reason.trim() !== '';
  // 패널이 새로 열리면 초점을 패널로 옮기고, 닫히면 숨긴 초안으로 입력을 받지 않습니다.
  useEffect((): void => {
    if (open && workspaceActive) panelRef.current?.focus();
  }, [open, workspaceActive]);
  // 열려 있는 동안만 개념을 눌러 주체, 그다음 대상 순서로 비어 있는 칸을 채웁니다.
  useEffect((): (() => void) | void => {
    if (!open) return;
    const fill = (entityId: string): void => {
      const { subject: currentSubject, object: currentObject } =
        form.getValues();
      const options = { shouldDirty: true, shouldValidate: false };
      if (!currentSubject) form.setValue('subject', entityId, options);
      else if (!currentObject && entityId !== currentSubject)
        form.setValue('object', entityId, options);
    };
    onPickerChange(fill);
    return (): void => onPickerChange(null);
  }, [open, form, onPickerChange]);
  const model = useOntologyDecision(basis, onSaved, onInvalidate);
  const knowledge = basis.assertion.knowledge;
  // 열어 본 문서면 제목, 아니면 파일 이름을 보입니다.
  const knownTitle = useRouteTitles().get(
    documentTitleKey(basis.assertion.knowledge.document),
  );
  const documentLabel = documentDisplayName(knowledge.document, knownTitle);
  // 사람이 추가하는 관계는 전문가 의견으로만 기록합니다.
  const allowed =
    basis.scope.permissions.includes('ontology_policy') &&
    knowledge.status === 'ready' &&
    knowledge.machineGraph.needs_reextraction !== true;
  /** 명시 제출 때만 요청 식별자를 만들고 같은 요청의 결과를 나중에 조회합니다. */
  async function submit(values: RelationValues): Promise<void> {
    if (!allowed || model.blocked) return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const {
      permissions: _permissions,
      connectionId,
      ...expectedScope
    } = basis.scope;
    await model.submit({
      connectionId,
      expectedScope,
      operation: 'relationCreate',
      input: {
        document: knowledge.document,
        request_id: requestId,
        expected_state_revision: knowledge.stateRevision,
        kind: values.kind,
        replacement: relationInput(basis, values),
        reason: values.reason,
      },
    });
  }
  const documentName = documentDisplayName(knowledge.document);
  // 주체·대상 후보는 같은 목록을 쓰므로 문서가 바뀔 때만 만듭니다.
  const concepts = useMemo(
    (): ConceptOption[] =>
      knowledge.machineGraph.entities.map(
        (entity: KnowledgeEntity): ConceptOption => ({
          id: entity.id,
          label: entity.label,
        }),
      ),
    [knowledge.machineGraph.entities],
  );
  /** 조건·범위·시점 입력은 한 곳에서 같은 방식으로 연결합니다. */
  const qualifierLabels = {
    condition: '조건',
    scope: '적용 범위',
    time: '시점',
  } as const;
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className={panelStyles.panel}
      hidden={!open}
    >
      <div className={panelStyles.document}>
        <strong>{documentLabel}</strong>
        {onChooseDocument && (
          <button
            type="button"
            onClick={onChooseDocument}
            disabled={model.state.phase === 'saving'}
          >
            대상 문서 변경
          </button>
        )}
      </div>
      <p className={styles.taskHint}>
        지도나 개념 목록에서 개념을 누르면 주체, 대상 순서로 채워집니다.
      </p>
      {model.state.phase === 'error' && (
        <div role="alert" className={styles.error}>
          <p>{model.state.error.message}</p>
          {model.requestId && model.state.error.code === 'outcome_unknown' && (
            <button
              type="button"
              onClick={(): void => {
                if (model.requestId) void model.reconcile(model.requestId);
              }}
            >
              추가 요청 저장 여부 확인
            </button>
          )}
        </div>
      )}
      {model.state.phase === 'saved' && (
        <div role="status" className={styles.notice}>
          <strong>새 관계가 저장되었습니다.</strong>
          {model.state.receipt.cleanupWarningCount > 0 && (
            <p>
              저장은 완료됐지만 임시 파일 정리 경고{' '}
              {model.state.receipt.cleanupWarningCount}건이 있습니다.
            </p>
          )}
        </div>
      )}
      <form
        className={styles.form}
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          void form.handleSubmit(submit)(event);
        }}
      >
        <fieldset disabled={model.blocked}>
          <Controller
            control={form.control}
            name="subject"
            render={({
              field,
            }: {
              field: ControllerRenderProps<RelationValues, 'subject'>;
            }): JSX.Element => (
              <ConceptPicker
                name="subject"
                value={field.value}
                options={concepts}
                documentName={documentName}
                invalid={!!form.formState.errors.subject}
                describedBy={
                  form.formState.errors.subject
                    ? `${errorId}-subject`
                    : undefined
                }
                onChange={field.onChange}
              />
            )}
          />
          <label>
            관계
            <select
              {...form.register('predicate')}
              aria-invalid={!!form.formState.errors.predicate}
              aria-describedby={
                form.formState.errors.predicate
                  ? `${errorId}-predicate`
                  : undefined
              }
            >
              <option value="">관계 선택</option>
              {relationPredicates.map((predicate: string): JSX.Element => (
                <option key={predicate} value={predicate}>
                  {relationPredicateLabel(predicate)}
                </option>
              ))}
            </select>
          </label>
          <Controller
            control={form.control}
            name="object"
            render={({
              field,
            }: {
              field: ControllerRenderProps<RelationValues, 'object'>;
            }): JSX.Element => (
              <ConceptPicker
                name="object"
                value={field.value}
                options={concepts}
                documentName={documentName}
                invalid={!!form.formState.errors.object}
                describedBy={
                  form.formState.errors.object ? `${errorId}-object` : undefined
                }
                onChange={field.onChange}
              />
            )}
          />
          <label>
            이유
            <textarea
              {...form.register('reason')}
              rows={4}
              placeholder="왜 이 관계를 추가하나요? 근거가 되는 자료나 내용을 적어도 됩니다."
              aria-invalid={!!form.formState.errors.reason}
              aria-describedby={
                form.formState.errors.reason ? `${errorId}-reason` : undefined
              }
            />
          </label>
          <p className={styles.taskHint}>
            전문가 의견으로 추가됩니다. 기록한 사용자와 시각은 서버가 남깁니다.
          </p>
          <details>
            <summary>추가 속성 (극성 · 조건 · 적용 범위 · 시점)</summary>
            <label>
              극성
              <select {...form.register('polarity')}>
                <option value="positive">긍정</option>
                <option value="negative">부정</option>
              </select>
            </label>
            {(['condition', 'scope', 'time'] as const).map(
              (key: 'condition' | 'scope' | 'time'): JSX.Element => (
                <label key={key}>
                  {qualifierLabels[key]}
                  <textarea {...form.register(key)} rows={2} />
                </label>
              ),
            )}
          </details>
          {Object.entries(form.formState.errors).map(
            ([key, error]: [string, { message?: string }]): JSX.Element => (
              <p key={key} role="alert" id={`${errorId}-${key}`}>
                {error.message}
              </p>
            ),
          )}
          <div className={styles.actions}>
            <button type="submit" disabled={!allowed || !filled}>
              저장
            </button>
            <button
              type="button"
              disabled={model.state.phase === 'saving'}
              onClick={onDiscard}
            >
              {model.state.phase === 'saved' ? '닫기' : '취소'}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
