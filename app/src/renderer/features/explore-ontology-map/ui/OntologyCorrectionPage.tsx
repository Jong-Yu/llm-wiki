import { Icon } from '@renderer/shared/ui/Icon';
import { useEffect, useId, useRef, useState } from 'react';
import type { SubmitEvent, JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import {
  buildCorrection,
  correctionDefaults,
  ontologyCorrectionSchema,
} from '../model/ontologyCorrection.schema';
import type { OntologyCorrectionValues } from '../model/ontologyCorrection.schema';
import type {
  CorrectionBasis,
  CorrectionReceipt,
  OntologyFailure,
} from '../model/ontologyMap.types';
import {
  invalidatesScope,
  saveOntologyCorrection,
} from '../api/ontologyMap.api';
import { valueObject } from '../model/buildOntologyGraph';
import { OntologyAssertionDetails } from './OntologyAssertionDetails';
import { OntologyReferencePane } from './OntologyReferencePane';
import styles from './OntologyMapWorkspace.module.scss';
import { useOntologyTaskFocus } from '../model/useOntologyTaskFocus';

type OntologyCorrectionPageProps = {
  basis: CorrectionBasis;
  open: boolean;
  onClose: () => void;
  onSaved: (receipt: CorrectionReceipt) => void;
  onInvalidate: () => void;
  onDiscard: () => void;
};
type SaveState =
  | { phase: 'idle' | 'saving' }
  | { phase: 'error'; error: OntologyFailure }
  | { phase: 'saved'; receipt: CorrectionReceipt };

/** 닫기와 실패에도 초안·CAS 기준을 유지하고 확인된 저장만 그래프 재조회로 연결합니다. */
export function OntologyCorrectionPage({
  basis,
  open,
  onClose,
  onSaved,
  onInvalidate,
  onDiscard,
}: OntologyCorrectionPageProps): JSX.Element {
  const focusAnchor = useOntologyTaskFocus(open);
  const errorId = useId();
  const [state, setState] = useState<SaveState>({ phase: 'idle' });
  const mounted = useRef(true);
  const saving = useRef(false);
  const form = useForm<OntologyCorrectionValues>({
    resolver: zodResolver(ontologyCorrectionSchema),
    defaultValues: correctionDefaults(basis),
  });
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const blocked =
    state.phase === 'saved' ||
    (state.phase === 'error' &&
      (state.error.code === 'outcome_unknown' ||
        state.error.code === 'conflict' ||
        state.error.status === 409 ||
        state.error.retry === 'reconcile'));
  const attribute = basis.assertion.collection === 'attributes';

  /** 명시 적용만 전송하며 중복 클릭과 응답 미확인 뒤 재전송을 막습니다. */
  async function submit(values: OntologyCorrectionValues): Promise<void> {
    if (saving.current || blocked) return;
    let replacement;
    try {
      replacement = buildCorrection(basis, values);
    } catch (error: unknown) {
      setState({
        phase: 'error',
        error: {
          code: 'invalid_input',
          message:
            error instanceof Error ? error.message : '입력을 확인해 주세요.',
        },
      });
      return;
    }
    saving.current = true;
    setState({ phase: 'saving' });
    const result = await saveOntologyCorrection(
      basis,
      replacement,
      values.reason,
    );
    saving.current = false;
    if (!mounted.current) return;
    if (!result.ok) {
      if (invalidatesScope(result.error)) {
        onInvalidate();
        return;
      }
      setState({ phase: 'error', error: result.error });
    } else {
      setState({ phase: 'saved', receipt: result.data });
      onSaved(result.data);
    }
  }

  return (
    <WorkspacePage
      hidden={!open}
      onBack={onClose}
      title="원문 근거 정정"
      backLabel="초안 보관하고 돌아가기"
      className={styles.taskPage}
    >
      <div ref={focusAnchor}>
        <OntologyAssertionDetails
          assertion={basis.assertion}
          section="summary"
        />
      </div>
      <div className={styles.taskComparison} data-ontology-comparison>
        <OntologyReferencePane basis={basis} fullSource />
        <section
          className={styles.editorPane}
          aria-label="수정할 내용"
          data-ontology-editor
        >
          <h2>수정할 내용</h2>
          <p className={styles.taskHint}>
            원문과 대조해 추출값을 수정하고 이유를 남깁니다.
          </p>
          <form
            className={styles.form}
            onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
              void form.handleSubmit(submit)(event);
            }}
          >
            {state.phase === 'error' && (
              <div role="alert" className={styles.error}>
                <strong>수정을 적용하지 못했습니다.</strong>
                <p>{state.error.message}</p>
                <p>작성한 값과 이전 그래프를 유지했습니다.</p>
                {state.error.cleanupWarningCount ? (
                  <p>임시 파일 정리 경고 {state.error.cleanupWarningCount}건</p>
                ) : null}
                {blocked && (
                  <Link
                    to={`/document?path=${encodeURIComponent(basis.assertion.document)}`}
                  >
                    현재 문서와 이력 확인{' '}
                    <Icon name="external-link" size={14} />
                  </Link>
                )}
              </div>
            )}
            {state.phase === 'saved' && (
              <div role="status" className={styles.notice}>
                <strong>원문 근거 정정이 저장되었습니다.</strong>
                {state.receipt.cleanupWarningCount > 0 && (
                  <p>
                    저장은 완료됐지만 임시 파일 정리{' '}
                    {state.receipt.cleanupWarningCount}건을 확인해야 합니다.
                    다시 적용하지 마세요.
                  </p>
                )}
              </div>
            )}
            {(['subject', 'object'] as const).map(
              (field: 'subject' | 'object'): JSX.Element | null =>
                typeof basis.assertion.value[field] === 'string' ? (
                  <label key={field}>
                    {field === 'subject' ? '주어' : '목적어'}
                    <select {...form.register(field)}>
                      {basis.assertion.knowledge.machineGraph.entities.map(
                        (
                          entity: (typeof basis.assertion.knowledge.machineGraph.entities)[number],
                        ): JSX.Element => (
                          <option key={entity.id} value={entity.id}>
                            {entity.label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : null,
            )}
            <label>
              {attribute ? '속성 이름' : '관계'}
              <input
                {...form.register('label')}
                aria-invalid={!!form.formState.errors.label}
                aria-describedby={
                  form.formState.errors.label ? `${errorId}-label` : undefined
                }
              />
            </label>
            {form.formState.errors.label && (
              <p role="alert" id={`${errorId}-label`}>
                {form.formState.errors.label.message}
              </p>
            )}
            {attribute &&
              (typeof basis.assertion.value.value === 'number' ||
                typeof basis.assertion.value.value === 'string') && (
                <label>
                  속성 값
                  <input
                    {...form.register('value')}
                    aria-invalid={!!form.formState.errors.value}
                    aria-describedby={
                      form.formState.errors.value
                        ? `${errorId}-value`
                        : undefined
                    }
                  />
                </label>
              )}
            {valueObject(basis.assertion.value.qualifiers) && (
              <label>
                조건
                <textarea
                  {...form.register('condition')}
                  rows={3}
                  aria-invalid={!!form.formState.errors.condition}
                  aria-describedby={
                    form.formState.errors.condition
                      ? `${errorId}-condition`
                      : undefined
                  }
                />
              </label>
            )}
            {form.formState.errors.value && (
              <p role="alert" id={`${errorId}-value`}>
                {form.formState.errors.value.message}
              </p>
            )}
            {form.formState.errors.condition && (
              <p role="alert" id={`${errorId}-condition`}>
                {form.formState.errors.condition.message}
              </p>
            )}
            <label>
              수정 이유
              <textarea
                {...form.register('reason')}
                rows={3}
                aria-invalid={!!form.formState.errors.reason}
                aria-describedby={
                  form.formState.errors.reason ? `${errorId}-reason` : undefined
                }
              />
            </label>
            {form.formState.errors.reason && (
              <p role="alert" id={`${errorId}-reason`}>
                {form.formState.errors.reason.message}
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="submit"
                disabled={blocked || state.phase === 'saving'}
              >
                {state.phase === 'saving'
                  ? '적용 중…'
                  : state.phase === 'error'
                    ? '같은 기준으로 다시 적용'
                    : '수정 적용'}
              </button>
              <button
                type="button"
                disabled={state.phase === 'saving'}
                onClick={onDiscard}
              >
                {state.phase === 'saved' ? '완료' : '수정안 버리기'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </WorkspacePage>
  );
}
