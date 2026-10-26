import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import { useId, useState } from 'react';
import type { JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { TextField } from '@renderer/shared/ui/TextField';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { useCorrespondences } from '../model/useCorrespondences';
import { searchSchema, stateLabel } from '../model/correspondence.schema';
import type {
  Detail,
  Found,
  Judgment,
  SearchValues,
} from '../model/correspondence.schema';
import {
  actionTitle,
  CorrespondenceActionForm,
} from './CorrespondenceActionForm';
import type { EditorTarget } from './CorrespondenceActionForm';
import {
  CorrespondenceDetails,
  CorrespondenceValueView,
} from './CorrespondenceValue';
import styles from './ManageCorrespondences.module.scss';

type JudgmentViewProps = { judgment: Judgment };
/** 판단과 적용 상태를 분리하고 상충·누락된 범위를 그대로 드러냅니다. */
function JudgmentView({ judgment }: JudgmentViewProps): JSX.Element {
  return (
    <section className={styles.judgment}>
      <p className={styles.states}>
        {judgment.lane === 'expert' ? '전문가 판단' : '원문 제안'} ·{' '}
        {stateLabel(judgment.decision)} · {stateLabel(judgment.applicability)}
      </p>
      {judgment.reasons.length > 0 && (
        <StatusNotice
          tone={judgment.applicability === 'applicable' ? 'info' : 'warning'}
        >
          {judgment.reasons
            .map((reason: string): string => stateLabel(reason))
            .join(' · ')}
        </StatusNotice>
      )}
      {judgment.conflict_refs.length > 0 && (
        <p>상충 판단: {judgment.conflict_refs.join(', ')}</p>
      )}
      {judgment.value ? (
        <CorrespondenceValueView value={judgment.value} />
      ) : (
        <p>활성 내용이 없는 판단입니다. 철회 이력을 확인해 주세요.</p>
      )}
    </section>
  );
}
type HistoryProps = { detail: Detail };
/** 당시의 전체 전후값을 현재 원문으로 바꾸지 않고 보여줍니다. */
function History({ detail }: HistoryProps): JSX.Element {
  return (
    <div className={styles.fields}>
      {detail.history.map(
        (event: KnowledgeValue, index: number): JSX.Element => (
          <details key={typeof event.id === 'string' ? event.id : index}>
            <summary>
              {index + 1}.{' '}
              {typeof event.action === 'string'
                ? stateLabel(event.action)
                : '변경'}{' '}
              · {typeof event.timestamp === 'string' ? event.timestamp : ''}
            </summary>
            <CorrespondenceDetails value={event} />
          </details>
        ),
      )}
    </div>
  );
}
export type ManageCorrespondencesProps = { initialDocument?: string };
/** 탐색과 읽기를 유지하며 대응 작성은 시안의 두 영역 대조 창에서 진행합니다. */
export function ManageCorrespondences({
  initialDocument = '',
}: ManageCorrespondencesProps): JSX.Element {
  const model = useCorrespondences();
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [judgmentId, setJudgmentId] = useState('source');
  const formId = useId();
  const search = useForm<SearchValues>({
    resolver: zodResolver(searchSchema),
    defaultValues: {
      documents: initialDocument,
      text: '',
      context: '',
      asOf: '',
    },
  });
  const scope = model.scope;
  const detail = model.detail;
  const editing =
    editor !== null && editor.scope === scope && model.write.status !== 'saved';
  const locked = ['preparing', 'saving', 'blocked'].includes(
    model.write.status,
  );
  const readOnly = !scope || locked || model.busy || editing;
  const canReview = scope?.permissions.includes('ontology_review') === true;
  const canPolicy = scope?.permissions.includes('ontology_policy') === true;
  /** 현재 읽은 원장과 판단을 새 폼 기준으로 명시 고정합니다. */
  function open(
    kind: EditorTarget['kind'],
    judgment: Judgment | null = null,
  ): void {
    if (!scope) return;
    model.reset();
    setEditor({ kind, detail, judgment, scope });
    setEditorVisible(true);
  }
  /** 초안 폐기는 사용자 행동에서만 실행합니다. */
  function close(): void {
    model.reset();
    setEditor(null);
    setEditorVisible(false);
  }
  return (
    <section className={styles.workspace} aria-label="조건·개념 대응 작업 공간">
      <WorkspaceToolbar className={styles.toolbar}>
        <h1>조건·개념 대응</h1>
        <span>
          {scope ? `${scope.tenant} · ${scope.profileId}` : '연결 확인'}
        </span>
        {editing && (
          <Button
            variant="secondary"
            onClick={(): void => setEditorVisible(true)}
          >
            작성 중인 대응 계속
          </Button>
        )}
        <Button
          disabled={readOnly || !scope?.permissions.includes('ontology_write')}
          onClick={(): void => open('propose')}
        >
          새 대응 제안
        </Button>
      </WorkspaceToolbar>
      <WorkspaceLayout className={styles.layout}>
        <WorkspacePane name="index">
          <aside className={styles.index} aria-label="대응 탐색">
            <h2>대응 찾기</h2>
            <form
              className={styles.fields}
              onSubmit={search.handleSubmit(model.search)}
            >
              <TextareaField
                label="검색할 위키 문서 (한 줄에 하나)"
                rows={2}
                description="명시한 1~8개 문서의 기존 대응을 조회합니다."
                error={search.formState.errors.documents?.message}
                {...search.register('documents')}
              />
              <TextField label="대응 검색어" {...search.register('text')} />
              <details
                className={styles.searchOptions}
                open={
                  !!search.formState.errors.context ||
                  !!search.formState.errors.asOf
                }
              >
                <summary>업무 범위·적용 시각</summary>
                <div className={styles.fields}>
                  <TextareaField
                    label="조회 업무 범위 (이름=값)"
                    description="미입력한 업무 축은 미확인으로 유지합니다."
                    error={search.formState.errors.context?.message}
                    {...search.register('context')}
                  />
                  <TextField
                    label="적용 확인 시각"
                    description="비우면 현재 시각 · 과거 시각은 옛 원장 복원이 아닙니다."
                    placeholder="2026-10-25T09:00:00+09:00"
                    error={search.formState.errors.asOf?.message}
                    {...search.register('asOf')}
                  />
                </div>
              </details>
              <Button
                type="submit"
                disabled={!scope || model.busy || locked || editing}
              >
                대응 검색
              </Button>
            </form>
            {model.found && (
              <>
                <p className={styles.muted}>
                  조회된 대응 {model.found.results.length}개 · 최대 50개
                </p>
                {(!model.found.complete ||
                  model.found.truncated ||
                  model.found.skipped.length > 0) && (
                  <StatusNotice tone="warning">
                    일부 결과입니다. 조회 한도 또는 읽지 못한 항목이 있습니다.
                    <details>
                      <summary>부분 조회 내역</summary>
                      <CorrespondenceDetails value={model.found.skipped} />
                    </details>
                  </StatusNotice>
                )}
                <ul className={styles.list} aria-label="대응 목록">
                  {model.found.results.map(
                    (item: Found['results'][number]): JSX.Element => (
                      <li key={item.correspondence_id}>
                        <button
                          type="button"
                          className={
                            detail?.correspondence_id === item.correspondence_id
                              ? styles.selected
                              : ''
                          }
                          aria-pressed={
                            detail?.correspondence_id === item.correspondence_id
                          }
                          disabled={editing || locked || model.busy}
                          onClick={(): void => {
                            setEditor(null);
                            void model.select(item.correspondence_id);
                          }}
                        >
                          <strong>
                            {item.source_proposal.value?.statement ||
                              '대응 판단'}
                          </strong>
                          <small>
                            {item.documents.condition} →{' '}
                            {item.documents.concept}
                          </small>
                          <small>
                            {stateLabel(item.source_proposal.decision)} ·{' '}
                            {stateLabel(item.source_proposal.applicability)}
                          </small>
                        </button>
                      </li>
                    ),
                  )}
                </ul>
                {model.found.results.length === 0 && (
                  <p>이번 조회 범위에서 대응을 찾지 못했습니다.</p>
                )}
              </>
            )}
          </aside>
        </WorkspacePane>
        <WorkspacePane name="content">
          <main
            key={`${detail?.correspondence_id}-${detail?.correspondence_revision}`}
            className={styles.content}
            aria-label="대응 내용"
          >
            {model.error && (
              <StatusNotice tone="error" title="조회 확인 필요">
                {model.error.message}
              </StatusNotice>
            )}
            {!scope && (
              <StatusNotice title="작업 공간 연결">
                <Link to="/setup/connection">
                  서버 연결과 작업 공간을 확인해 주세요.
                </Link>
              </StatusNotice>
            )}
            {model.busy && <StatusNotice>대응을 읽고 있습니다.</StatusNotice>}
            {(model.write.status === 'error' ||
              model.write.status === 'blocked') && (
              <StatusNotice
                tone="warning"
                title={
                  model.write.status === 'blocked'
                    ? '초안을 보존했습니다'
                    : '변경을 완료하지 못했습니다'
                }
              >
                {model.write.error.message}
                {model.write.status === 'blocked' && (
                  <p>
                    최신 내용은 별도 대조본으로 읽습니다. 이전 초안의 판본을
                    자동 교체하지 않습니다.
                  </p>
                )}
              </StatusNotice>
            )}
            {model.write.status === 'saved' && (
              <StatusNotice tone="success">{model.write.message}</StatusNotice>
            )}
            {scope &&
              model.write.status === 'error' &&
              model.write.error.code === 'storage_busy' &&
              model.write.pending && (
                <Button
                  onClick={(): void => {
                    void model.save();
                  }}
                >
                  같은 기준으로 저장 재시도
                </Button>
              )}
            {detail && scope ? (
              <Tabs
                label="대응 판단 출처"
                value={
                  detail.policies.some(
                    (judgment: Judgment): boolean =>
                      judgment.judgment_id === judgmentId,
                  )
                    ? judgmentId
                    : 'source'
                }
                onValueChange={setJudgmentId}
                items={[
                  {
                    id: 'source',
                    label: '원문 제안·검토',
                    content: <JudgmentView judgment={detail.source_proposal} />,
                  },
                  ...detail.policies.map(
                    (
                      judgment: Judgment,
                      index: number,
                    ): { id: string; label: string; content: JSX.Element } => ({
                      id: judgment.judgment_id || judgment.event_id,
                      label: `전문가 판단 ${index + 1} · ${stateLabel(judgment.decision)}`,
                      content: <JudgmentView judgment={judgment} />,
                    }),
                  ),
                ]}
              />
            ) : (
              scope && (
                <div className={styles.emptyState}>
                  <p className={styles.eyebrow}>문서 연결 · 조건과 개념</p>
                  <h2>서로 다른 문서의 의미를 대조하세요</h2>
                  <p>
                    조건을 담은 원문과 개념을 설명하는 원문을 나란히 읽고,
                    <br />두 의미를 연결하는 근거와 적용 범위를 기록합니다.
                  </p>
                  <div className={styles.emptySteps}>
                    <section>
                      <strong>01 · 원문 대조</strong>
                      <p>양쪽 문서의 판본과 인용 확인</p>
                    </section>
                    <section>
                      <strong>02 · 연결 근거</strong>
                      <p>후보·원문 정의·전문가 판단 구분</p>
                    </section>
                    <section>
                      <strong>03 · 명시 반영</strong>
                      <p>준비된 변경을 대조한 뒤 저장</p>
                    </section>
                  </div>
                </div>
              )
            )}
            {scope && model.inspection && (
              <section className={styles.card}>
                <h2>최신 내용 대조본</h2>
                <p>원래 초안의 기준은 유지됩니다.</p>
                <JudgmentView judgment={model.inspection.source_proposal} />
                <History detail={model.inspection} />
              </section>
            )}
          </main>
        </WorkspacePane>
        <WorkspacePane name="inspector">
          <aside className={styles.inspector} aria-label="대응 판단과 이력">
            <h2>판단·이력</h2>
            {scope && (
              <>
                <div className={styles.fields}>
                  {detail && (
                    <>
                      <p className={styles.muted}>
                        {detail.documents.condition} →{' '}
                        {detail.documents.concept}
                      </p>
                      {!detail.complete && (
                        <StatusNotice tone="warning">
                          의존 자료를 모두 확인하지 못했습니다.
                        </StatusNotice>
                      )}
                      <div
                        className={styles.actionGroup}
                        aria-label="원문 검토와 업무 판단"
                      >
                        <Button
                          variant="secondary"
                          disabled={
                            readOnly ||
                            !canReview ||
                            detail.source_proposal.value?.basis.kind !==
                              'source'
                          }
                          onClick={(): void =>
                            open('accept', detail.source_proposal)
                          }
                        >
                          원문 근거 수용
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={readOnly || !canReview}
                          onClick={(): void =>
                            open('edit', detail.source_proposal)
                          }
                        >
                          원문 해석 수정
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={readOnly || !canReview}
                          onClick={(): void =>
                            open('defer', detail.source_proposal)
                          }
                        >
                          보류
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={readOnly || !canReview}
                          onClick={(): void =>
                            open('reject', detail.source_proposal)
                          }
                        >
                          거절
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={readOnly || !canPolicy}
                          onClick={(): void => open('policy')}
                        >
                          별도 전문가 판단
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={
                            readOnly ||
                            !canPolicy ||
                            detail.source_proposal.decision !== 'accepted'
                          }
                          onClick={(): void =>
                            open('policy', detail.source_proposal)
                          }
                        >
                          수용 판단을 업무 정책으로 대체
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={
                            readOnly ||
                            !canReview ||
                            !detail.history.some(
                              (event: KnowledgeValue): boolean =>
                                event.id === detail.source_proposal.event_id &&
                                event.action !== 'propose',
                            )
                          }
                          onClick={(): void =>
                            open('review_undo', detail.source_proposal)
                          }
                        >
                          최근 원문 검토 되돌림
                        </Button>
                      </div>
                      {detail.policies.map(
                        (judgment: Judgment): JSX.Element => (
                          <section
                            className={styles.card}
                            key={judgment.judgment_id}
                          >
                            <p>
                              {judgment.value?.statement || '비활성 업무 판단'}
                            </p>
                            <p>
                              {stateLabel(judgment.decision)} ·{' '}
                              {stateLabel(judgment.applicability)}
                            </p>
                            <Button
                              variant="secondary"
                              disabled={
                                readOnly ||
                                !canPolicy ||
                                judgment.decision !== 'active'
                              }
                              onClick={(): void => open('policy', judgment)}
                            >
                              이 업무 판단 변경
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={readOnly || !canPolicy}
                              onClick={(): void =>
                                open('policy_undo', judgment)
                              }
                            >
                              이 업무 판단 되돌림
                            </Button>
                          </section>
                        ),
                      )}
                    </>
                  )}
                  {(detail || model.write.status === 'blocked') && (
                    <Button
                      variant="secondary"
                      disabled={
                        model.busy ||
                        model.write.status === 'saving' ||
                        model.write.status === 'preparing'
                      }
                      onClick={(): void => {
                        void model.inspect();
                      }}
                    >
                      최신 내용·이력 대조
                    </Button>
                  )}
                </div>
                <p className={styles.muted}>
                  원문 근거 검토와 전문가 판단은 별도 권한·출처를 사용합니다.
                  대응 수용은 주변 주장 전체의 승인이나 개별 대상의 조건 충족을
                  뜻하지 않습니다.
                </p>
                {detail && (
                  <>
                    <details>
                      <summary>
                        저장된 전체 변경 이력 · {detail.history.length}건
                      </summary>
                      <History detail={detail} />
                    </details>
                    <details>
                      <summary>조회 기준·실제 의존 자료</summary>
                      <CorrespondenceDetails
                        value={{
                          correspondence_id: detail.correspondence_id,
                          correspondence_revision:
                            detail.correspondence_revision,
                          dependencies: detail.dependencies ?? null,
                          evaluated_at: detail.evaluated_at ?? null,
                          application_context:
                            detail.application_context ?? null,
                        }}
                      />
                    </details>
                  </>
                )}
              </>
            )}
          </aside>
        </WorkspacePane>
      </WorkspaceLayout>
      {scope && editing && editor && (
        <Dialog
          open={editorVisible}
          onOpenChange={setEditorVisible}
          title={`문서 간 조건·개념 대응 · ${actionTitle(editor.kind)}`}
          description="문서 연결 / 대응 제안·판단 · 양쪽 원문과 연결 근거, 적용 범위를 대조합니다."
          closeLabel="입력 보존하고 닫기"
          className={styles.editorDialog}
          actions={
            <>
              <p className={styles.footerNote}>
                {model.write.status === 'prepared'
                  ? '준비한 판본과 변경 내용을 확인했습니다. 저장 버튼을 눌러야 반영됩니다.'
                  : '입력은 준비 단계에서 대조합니다. 저장 전까지 원문과 판단은 바뀌지 않습니다.'}
              </p>
              <Button
                variant="secondary"
                disabled={
                  model.write.status === 'saving' ||
                  model.write.status === 'preparing' ||
                  (model.write.status === 'blocked' && !!model.write.pending)
                }
                onClick={close}
              >
                초안 버리고 닫기
              </Button>
              {model.write.status === 'prepared' ? (
                <>
                  <Button variant="secondary" onClick={model.clearPrepared}>
                    입력 수정·다시 대조
                  </Button>
                  <Button
                    onClick={(): void => {
                      void model.save();
                    }}
                  >
                    준비한 변경 저장
                  </Button>
                </>
              ) : model.write.status === 'blocked' ? (
                <Button
                  disabled={model.busy}
                  onClick={(): void => {
                    void model.inspect();
                  }}
                >
                  최신 내용·이력 대조
                </Button>
              ) : model.write.status === 'error' &&
                model.write.error.code === 'storage_busy' &&
                model.write.pending ? (
                <Button
                  onClick={(): void => {
                    void model.save();
                  }}
                >
                  같은 기준으로 저장 재시도
                </Button>
              ) : (
                <Button type="submit" form={formId} disabled={locked}>
                  {model.write.status === 'preparing'
                    ? '변경 준비 중…'
                    : model.write.status === 'saving'
                      ? '저장 중…'
                      : '변경 내용 준비'}
                </Button>
              )}
            </>
          }
        >
          {(model.write.status === 'error' ||
            model.write.status === 'blocked' ||
            model.error ||
            model.inspection) && (
            <div className={styles.dialogFeedback}>
              {(model.write.status === 'error' ||
                model.write.status === 'blocked') && (
                <StatusNotice
                  tone="warning"
                  title={
                    model.write.status === 'blocked'
                      ? '초안을 보존했습니다'
                      : '변경을 완료하지 못했습니다'
                  }
                >
                  {model.write.error.message}
                </StatusNotice>
              )}
              {model.error && (
                <StatusNotice tone="error">{model.error.message}</StatusNotice>
              )}
              {model.inspection && (
                <details>
                  <summary>최신 내용 대조본 · 원래 초안의 기준 유지</summary>
                  <JudgmentView judgment={model.inspection.source_proposal} />
                  <History detail={model.inspection} />
                </details>
              )}
            </div>
          )}
          <CorrespondenceActionForm
            key={model.editorVersion}
            formId={formId}
            target={editor}
            prepared={
              model.write.status === 'prepared' ? model.write.value : null
            }
            scope={scope}
            locked={locked}
            onPrepare={model.prepare}
            onChange={model.clearPrepared}
            onInvalidated={model.invalidate}
          />
        </Dialog>
      )}
    </section>
  );
}
