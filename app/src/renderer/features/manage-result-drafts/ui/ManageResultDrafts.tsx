import type { ChangeEvent, JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import {
  canApplyDraft,
  draftFormSchema,
  targetFormSchema,
} from '../model/resultDrafts';
import type { DraftForm, DraftPage } from '../model/resultDrafts';
import { useResultDrafts } from '../model/useResultDrafts';
import type { ResultDraftModel } from '../model/useResultDrafts';
import styles from './ManageResultDrafts.module.scss';

export type ManageResultDraftsProps = {
  navigation?: ReactNode;
  savedResultId?: string;
};
type DraftEditorProps = { model: ResultDraftModel };
type DraftCreationProps = {
  model: ResultDraftModel;
  savedResultId?: string;
  disabled: boolean;
};
const creationSchema = z.object({
  savedResultId: z
    .string()
    .regex(/^[a-f0-9]{32}$/, '저장 결과의 식별자를 확인해 주세요.'),
});
type CreationForm = z.infer<typeof creationSchema>;
type TargetForm = z.infer<typeof targetFormSchema>;
/** 실제 저장 결과를 명시적으로 선택한 경우에만 개인 초안을 생성합니다. */
function DraftCreation({
  model,
  savedResultId,
  disabled,
}: DraftCreationProps): JSX.Element {
  const form = useForm<CreationForm>({
    resolver: zodResolver(creationSchema),
    defaultValues: { savedResultId: savedResultId || '' },
  });
  return (
    <form
      className={styles.form}
      onSubmit={form.handleSubmit(async (value: CreationForm): Promise<void> =>
        model.create(value.savedResultId),
      )}
    >
      <TextField
        label="저장 결과 ID"
        {...form.register('savedResultId')}
        error={form.formState.errors.savedResultId?.message}
        readOnly={!!savedResultId}
        disabled={disabled}
      />
      <Button disabled={disabled} type="submit">
        이 저장 결과로 초안 만들기
      </Button>
      <p>원래 생성문·전체 고정 근거·답변 계보가 함께 보관됩니다.</p>
    </form>
  );
}
/** 원래 서술과 사용자의 편집 내용을 별도로 보존하는 초안 폼입니다. */
function DraftEditor({ model }: DraftEditorProps): JSX.Element {
  const { state } = model;
  const form = useForm<DraftForm>({
    resolver: zodResolver(draftFormSchema),
    values: state.form,
  });
  const target = useForm<TargetForm>({
    resolver: zodResolver(targetFormSchema),
    defaultValues: { document: state.target?.document || '' },
  });
  const selected = state.selected;
  if (!selected || model.session.status !== 'ready') return <></>;
  const permissions = model.session.data.permissions;
  const canEdit = permissions.includes('result_write');
  const dirty =
    state.form.title !== selected.draft.title ||
    state.form.content !== selected.draft.content;
  const disabled = model.busy || !!state.pending;
  const titleInput = form.register('title');
  const contentInput = form.register('content');
  const targetInput = target.register('document');
  return (
    <>
      <header>
        <h2>{selected.draft.title}</h2>
        <p>개인 초안 · 원본 결과 {selected.record.data.source_result_id}</p>
      </header>
      <form
        className={styles.form}
        onSubmit={form.handleSubmit(async (value: DraftForm): Promise<void> =>
          model.save(value),
        )}
      >
        <TextField
          label="초안 제목"
          {...titleInput}
          error={form.formState.errors.title?.message}
          disabled={disabled || !canEdit}
          onChange={(event: ChangeEvent<HTMLInputElement>): void => {
            void titleInput.onChange(event);
            model.changeForm({ ...state.form, title: event.target.value });
          }}
        />
        <TextareaField
          label="편집할 Markdown 본문"
          {...contentInput}
          rows={12}
          error={form.formState.errors.content?.message}
          disabled={disabled || !canEdit}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
            void contentInput.onChange(event);
            model.changeForm({ ...state.form, content: event.target.value });
          }}
        />
        <div className={styles.actions}>
          <Button
            type="submit"
            disabled={disabled || !canEdit || !dirty || state.conflict}
          >
            개인 초안 저장
          </Button>
          {dirty && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={model.resetForm}
            >
              저장된 초안으로 되돌리기
            </Button>
          )}
          <span>
            {dirty ? '저장하지 않은 편집 내용' : '서버에 보관된 초안'}
          </span>
        </div>
      </form>
      <details>
        <summary>원래 생성문·제목</summary>
        <h3>{selected.record.data.original_generated_title}</h3>
        <pre>{selected.record.data.original_generated_content}</pre>
      </details>
      {model.previousForm && (
        <details open>
          <summary>보존한 내 편집 내용 · 직접 병합</summary>
          <h3>{model.previousForm.title}</h3>
          <pre>{model.previousForm.content}</pre>
        </details>
      )}
      {state.conflict && (
        <StatusNotice tone="warning" title="기준이 변경되어 반영을 멈췄습니다">
          <p>
            내 편집 내용은 그대로 유지됩니다. 최신 초안을 읽고 대조한 뒤 병합
            편집을 시작하세요.
          </p>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={(): void => {
              void model.inspect();
            }}
          >
            최신 초안·근거 읽기
          </Button>
        </StatusNotice>
      )}
      {state.inspection && (
        <section className={styles.comparison}>
          <h3>최신 초안 · 대조 전용</h3>
          <p>{state.inspection.draft.title}</p>
          <pre>{state.inspection.draft.content}</pre>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={model.beginMerge}
          >
            최신 초안으로 병합 편집 시작
          </Button>
        </section>
      )}
      <section className={styles.application} aria-label="Wiki 반영 비교">
        <h3>대상 Wiki와 비교</h3>
        <p>
          초안을 저장한 다음 전체 근거 부록을 포함한 실제 반영 본문을
          비교합니다. 기존 문서는 전체 본문이 교체되고 이전 파일은 이력에
          보존됩니다.
        </p>
        <form
          className={styles.form}
          onSubmit={target.handleSubmit(
            async (value: TargetForm): Promise<void> =>
              model.target(value.document),
          )}
        >
          <TextField
            label="대상 Wiki 경로"
            placeholder="results/결과.md"
            {...targetInput}
            error={target.formState.errors.document?.message}
            disabled={disabled}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              void targetInput.onChange(event);
              model.clearTarget();
            }}
          />
          <Button type="submit" variant="secondary" disabled={disabled}>
            대상 본문 읽기·비교
          </Button>
        </form>
        {state.target && (
          <>
            <div className={styles.compareColumns}>
              <section>
                <h4>
                  {state.target.revision
                    ? '현재 Wiki 전체 본문'
                    : '새 Wiki 문서'}
                </h4>
                <p>{state.target.document}</p>
                <pre>
                  {state.target.content ||
                    (state.target.revision
                      ? '(빈 본문)'
                      : '현재 해당 문서가 없습니다.')}
                </pre>
              </section>
              <section>
                <h4>반영할 전체 본문·근거 부록</h4>
                <pre>{selected.rendered_content}</pre>
              </section>
            </div>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={state.compared}
                disabled={disabled || dirty || state.conflict}
                onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                  model.setCompared(event.target.checked)
                }
              />
              <span>
                대상 본문과 전체 반영 내용을 비교했으며{' '}
                {state.target.revision ? '전체 본문 교체' : '새 문서 생성'}를
                확인합니다.
              </span>
            </label>
          </>
        )}
        <p>
          전체 반영 크기: {selected.rendered_size_bytes.toLocaleString()} /
          1,048,576 bytes {dirty ? '· 편집 내용 저장 후 다시 계산됩니다.' : ''}
        </p>
        {!selected.can_apply_size && (
          <StatusNotice tone="warning">
            전체 고정 근거를 포함하면 1 MiB를 초과합니다. 근거 부록을 잘라서
            반영하지 않습니다. 개인 초안은 보존됩니다.
          </StatusNotice>
        )}
        {selected.basis_observation.status === 'unavailable' && (
          <StatusNotice tone="warning">
            현재 근거 일부를 확인할 수 없어 반영할 수 없습니다.
          </StatusNotice>
        )}
        {selected.basis_observation.status === 'changed' && (
          <label className={styles.check}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={
                state.acknowledged ===
                selected.basis_observation.observation_revision
              }
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                model.setAcknowledged(event.target.checked)
              }
            />
            <span>
              최신 관측과 작성 당시 근거의 차이를 확인했습니다. 당시 근거로
              작성한 문서임을 유지합니다.
            </span>
          </label>
        )}
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={(): void => {
              void model.inspect();
            }}
          >
            근거 변화 새로 확인
          </Button>
          <Button
            disabled={disabled || !canApplyDraft(state, permissions)}
            onClick={(): void => {
              void model.apply();
            }}
          >
            Wiki에 명시 반영
          </Button>
        </div>
        {(!permissions.includes('write') || !canEdit) && (
          <p>
            Wiki 반영에는 결과 편집과 Wiki 쓰기 권한이 모두 필요합니다. 조회와
            영수증 확인은 읽기 권한으로 가능합니다.
          </p>
        )}
        {state.applied && (
          <details open>
            <summary>실제 반영 영수증</summary>
            {state.applied.saved === true && state.applied.receipt && (
              <p>
                <Link
                  to={`/documents?document=${encodeURIComponent(state.applied.receipt.document)}`}
                >
                  반영한 Wiki 열기
                </Link>
              </p>
            )}
            <pre>{JSON.stringify(state.applied, null, 2)}</pre>
            {state.applied.cleanup_failures.length > 0 && (
              <StatusNotice tone="warning">
                저장은 완료되었으며 임시 파일 정리 경고가{' '}
                {state.applied.cleanup_failures.length}건 있습니다. 저장을 다시
                시도하지 않습니다.
              </StatusNotice>
            )}
            {state.applied.saved && state.applied.state !== 'complete' && (
              <StatusNotice tone="warning">
                저장 성공은 확인됐지만 영수증 연결 마무리가 완료되지 않았습니다.
                같은 문서를 다시 저장하지 마세요.
              </StatusNotice>
            )}
          </details>
        )}
      </section>
    </>
  );
}
/** 초안 목록·편집·전체 고정 근거를 독립 스크롤 패널로 연결합니다. */
export function ManageResultDrafts({
  navigation,
  savedResultId,
}: ManageResultDraftsProps): JSX.Element {
  const model = useResultDrafts();
  const { state } = model;
  if (model.session.status !== 'ready')
    return (
      <div>
        {navigation}
        <StatusNotice
          tone={model.session.status === 'error' ? 'error' : 'info'}
          title={
            model.session.status === 'error'
              ? '현재 접근 범위를 확인해 주세요'
              : '초안의 개인 범위를 확인하고 있습니다'
          }
        >
          {model.session.status === 'error' ? model.session.error.message : ''}
        </StatusNotice>
      </div>
    );
  const selected = state.selected;
  const dirty =
    !!selected &&
    (state.form.title !== selected.draft.title ||
      state.form.content !== selected.draft.content);
  const blocked = model.busy || !!state.pending || dirty || state.conflict;
  return (
    <div className={styles.workspace}>
      <WorkspaceToolbar className={styles.toolbar}>
        <div>
          <h1>결과 초안·Wiki 반영</h1>
          <p>
            개인 보관 · {model.session.data.tenant} ·{' '}
            {model.session.data.profileId}
          </p>
        </div>
        {navigation}
        <Button
          variant="secondary"
          disabled={model.busy}
          onClick={(): void => {
            void model.refresh();
          }}
        >
          목록 새로 읽기
        </Button>
      </WorkspaceToolbar>
      {model.recoveryNotice && (
        <StatusNotice tone="info">{model.recoveryNotice}</StatusNotice>
      )}
      <Button
        variant="secondary"
        disabled={model.busy || !!state.pending}
        onClick={(): void => {
          void model.discardRecovery();
        }}
      >
        이 화면의 로컬 복구 사본 삭제
      </Button>
      <WorkspaceLayout
        className={styles.panels}
        labels={{
          index: '초안 목록',
          content: '편집·비교',
          inspector: '전체 근거',
        }}
      >
        <WorkspacePane name="index">
          <aside className={styles.index} aria-label="결과 초안 목록">
            <h2>나의 결과 초안</h2>
            <DraftCreation
              key={savedResultId || 'manual'}
              model={model}
              savedResultId={savedResultId}
              disabled={
                blocked ||
                !model.session.data.permissions.includes('result_write')
              }
            />
            <div className={styles.list}>
              {!model.page ? (
                <p>목록을 읽고 있습니다.</p>
              ) : (
                <>
                  {model.page.items.length === 0 && (
                    <p>저장된 초안이 없습니다.</p>
                  )}
                  {model.page.items.map(
                    (item: DraftPage['items'][number]): JSX.Element => (
                      <button
                        type="button"
                        key={item.id}
                        className={
                          selected?.record.id === item.id
                            ? styles.selected
                            : styles.item
                        }
                        disabled={blocked}
                        onClick={(): void => {
                          void model.select(item.id);
                        }}
                      >
                        <strong>{item.title}</strong>
                        <small>{item.created_at}</small>
                      </button>
                    ),
                  )}
                  {(!model.page.complete ||
                    model.page.truncated ||
                    model.page.skipped.length > 0) && (
                    <StatusNotice tone="warning">
                      목록의 일부를 읽지 못했습니다.
                    </StatusNotice>
                  )}
                  <div className={styles.actions}>
                    <Button
                      variant="secondary"
                      disabled={model.busy}
                      onClick={(): void => {
                        void model.refresh();
                      }}
                    >
                      첫 페이지
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={model.busy || !model.page.next_cursor}
                      onClick={(): void => {
                        void model.refresh(model.page?.next_cursor || null);
                      }}
                    >
                      다음 페이지
                    </Button>
                  </div>
                </>
              )}
            </div>
          </aside>
        </WorkspacePane>
        <WorkspacePane name="content">
          <main className={styles.editor} aria-label="결과 초안 편집">
            {state.message && (
              <StatusNotice
                tone={
                  state.applied?.saved || (!state.pending && !state.conflict)
                    ? 'success'
                    : 'warning'
                }
              >
                {state.message}
              </StatusNotice>
            )}
            {state.error && (
              <StatusNotice tone="error">
                <p>{state.error.message}</p>
                {state.error.cleanupWarningCount ? (
                  <p>
                    저장 오류와 별도로 정리 오류{' '}
                    {state.error.cleanupWarningCount}건이 있습니다.
                  </p>
                ) : null}
                {state.error.code === 'storage_busy' && (
                  <p>
                    내용과 기준 판본을 유지했습니다. 잠시 후 같은 기준으로 명시
                    재시도할 수 있습니다.
                  </p>
                )}
              </StatusNotice>
            )}
            {state.pending && (
              <StatusNotice
                tone="warning"
                title={model.busy ? '요청 처리 중' : '저장 결과 미확인'}
              >
                <p>요청 ID: {state.pending.requestId}</p>
                <p>
                  초안과 요청을 보존했습니다. 새 저장을 보내기 전에 동일 요청
                  영수증을 조회합니다.
                </p>
                <Button
                  variant="secondary"
                  disabled={model.busy}
                  onClick={(): void => {
                    void model.confirm();
                  }}
                >
                  동일 요청 영수증 확인
                </Button>
              </StatusNotice>
            )}
            {selected ? (
              <DraftEditor key={selected.record.id} model={model} />
            ) : (
              <p className={styles.empty}>
                저장 결과에서 초안을 만들거나 목록의 실제 초안을 선택하세요.
                읽기만으로 Wiki가 변경되지 않습니다.
              </p>
            )}
          </main>
        </WorkspacePane>
        <WorkspacePane name="inspector">
          <aside className={styles.inspector} aria-label="작성 당시 전체 근거">
            <h2>작성 당시 근거·답변 계보</h2>
            {selected ? (
              <>
                <p>클라이언트 보고 자료 · 사람의 승인 없음</p>
                <details open>
                  <summary>
                    최신 근거 관측 ·{' '}
                    {selected.basis_observation.status === 'current'
                      ? '일치'
                      : selected.basis_observation.status === 'changed'
                        ? '변경됨'
                        : '확인 불가'}
                  </summary>
                  <pre>
                    {JSON.stringify(selected.basis_observation, null, 2)}
                  </pre>
                </details>
                <details open>
                  <summary>전체 고정 근거</summary>
                  <pre>
                    {JSON.stringify(selected.record.data.basis, null, 2)}
                  </pre>
                </details>
                <details>
                  <summary>답변 인용·실행 계보</summary>
                  <pre>
                    {JSON.stringify(
                      selected.record.data.answer_provenance,
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <details>
                  <summary>초안 판본·전체 편집 이력</summary>
                  <p>{selected.revision}</p>
                  <pre>{JSON.stringify(selected.record.events, null, 2)}</pre>
                </details>
              </>
            ) : (
              <p>초안을 선택하면 실제 저장된 전체 근거를 보여 줍니다.</p>
            )}
          </aside>
        </WorkspacePane>
      </WorkspaceLayout>
    </div>
  );
}
