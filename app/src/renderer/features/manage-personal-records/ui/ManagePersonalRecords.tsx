import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import { useState } from 'react';
import { Link } from 'react-router';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import type { QuestionSource } from '../model/personalForms';
import type { JSX, ReactNode } from 'react';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { usePersonalRecords } from '../model/usePersonalRecords';
import type { PersonalModel } from '../model/usePersonalRecords';
import {
  jsonText,
  personalKind,
  readBasis,
  textValue,
  writePermission,
} from '../model/personalRecords';
import type {
  PendingReceipt,
  PersonalBasis,
  PersonalMode,
  PersonalMutation,
  PersonalPage,
  PersonalSession,
  RecordEnvelope,
} from '../model/personalRecords';
import { BasisInspector } from './BasisInspector';
import { PersonalContent } from './PersonalContent';
import {
  AnswerForm,
  DirectResultForm,
  PersonalTitleDialog,
  QuestionForm,
} from './PersonalForms';
import type { PersonalFormActions } from './PersonalForms';
import {
  ComparisonCompletion,
  ComparisonCreateForm,
  MappingCards,
  readMappings,
} from './ComparisonForms';
import styles from './ManagePersonalRecords.module.scss';

export type PersonalQuestionContext = {
  canWrite: boolean;
  onChanged: () => void;
  session: { connectionId: string; expectedScope: WorkspaceScope };
  question: {
    conversationId: string;
    questionTurnId: string;
    conversationRevision: string;
  };
};
type PersonalExtensions = {
  onQuestionChanged?: () => void;
  initialDocument?: string;
  initialSource?: QuestionSource;
  renderQuestion?: (context: PersonalQuestionContext) => ReactNode;
};
export type ManagePersonalRecordsProps = PersonalExtensions & {
  mode: PersonalMode;
  navigation?: ReactNode;
};
type PersonalWorkspaceProps = PersonalExtensions & {
  navigation?: ReactNode;
  mode: PersonalMode;
  session: PersonalSession;
  model: PersonalModel;
};
type Inspection = { basis: PersonalBasis; label: string };
type ConversationProps = PersonalFormActions &
  PersonalExtensions & {
    conversation: RecordEnvelope;
    onSaveAnswer: (turnId: string) => void;
  };
type RecordDetailsProps = PersonalFormActions &
  PersonalExtensions & {
    mode: PersonalMode;
    record: RecordEnvelope;
    onSaveAnswer: (turnId: string) => void;
  };

/** 실제 질문과 client_reported 답변을 순서대로 보여 주고 각 당시 근거를 선택합니다. */
function Conversation({
  conversation,
  renderQuestion,
  onQuestionChanged,
  initialDocument,
  initialSource,
  onSaveAnswer,
  ...actions
}: ConversationProps): JSX.Element {
  const [tab, setTab] = useState('question');
  const [questionTurnId, setQuestionTurnId] = useState<string | null>(null);
  return (
    <div className={styles.conversation}>
      <div className={styles.messages}>
        {conversation.record.events.length === 0 && (
          <div className={styles.chatEmpty}>
            <strong>축적한 지식으로 무엇을 알아볼까요?</strong>
            <p>
              문서와 원본 판본을 선택해 질문을 보관한 뒤 개인 AI로 실행할 수
              있습니다.
            </p>
          </div>
        )}
        {conversation.record.events.map(
          (event: KnowledgeValue, index: number): JSX.Element => {
            const basis = readBasis(event.basis);
            const question = event.role === 'user';
            const content = textValue(event, 'content');
            const id = textValue(event, 'id');
            const reply = conversation.record.events.find(
              (item: KnowledgeValue): boolean => item.id === event.reply_to,
            );
            return (
              <article
                key={id || String(index)}
                className={question ? styles.question : styles.answer}
              >
                <header>
                  <strong>
                    {question
                      ? '내 질문'
                      : event.question_run_id
                        ? '개인 AI 답변'
                        : '외부·직접 작성 답변'}
                  </strong>
                  <small>{textValue(event, 'recorded_at')}</small>
                </header>
                {!question && (
                  <small className={styles.muted}>
                    개인 실행·작성 보고 · 사람 승인 없음
                  </small>
                )}
                {reply && (
                  <details>
                    <summary>답변이 참조한 실제 질문</summary>
                    <p>{textValue(reply, 'content')}</p>
                  </details>
                )}
                {event.status === 'failed' && (
                  <StatusNotice tone="warning">
                    외부 응답 실패로 보관한 기록입니다.
                  </StatusNotice>
                )}
                <PersonalContent content={content} />
                <div className={styles.actions}>
                  {question && renderQuestion && (
                    <Button
                      variant="secondary"
                      disabled={actions.blocked}
                      onClick={(): void => setQuestionTurnId(id)}
                    >
                      이 질문 실행
                    </Button>
                  )}
                  {basis && (
                    <Button
                      variant="secondary"
                      onClick={(): void =>
                        actions.onInspect(
                          basis,
                          question
                            ? '질문을 저장한 당시 기준'
                            : '참조 질문의 저장 당시 기준',
                        )
                      }
                    >
                      근거{' '}
                      {basis.documents.length + (basis.originals?.length || 0)}
                      개 보기
                    </Button>
                  )}
                  {!question &&
                    event.status === 'complete' &&
                    actions.session.permissions.includes('result_write') && (
                      <Button
                        variant="secondary"
                        disabled={actions.blocked}
                        onClick={(): void => onSaveAnswer(id)}
                      >
                        결과 초안으로 보관
                      </Button>
                    )}
                </div>
                <details>
                  <summary>기록 원형·출처</summary>
                  <pre>{jsonText(event)}</pre>
                </details>
              </article>
            );
          },
        )}
      </div>
      <div className={styles.composer}>
        {renderQuestion &&
          questionTurnId &&
          renderQuestion({
            canWrite:
              actions.session.permissions.includes('conversation_write') &&
              !actions.blocked,
            onChanged: (): void => onQuestionChanged?.(),
            session: {
              connectionId: actions.session.connectionId,
              expectedScope: {
                userId: actions.session.userId,
                tenant: actions.session.tenant,
                profileId: actions.session.profileId,
                policyRevision: actions.session.policyRevision,
              },
            },
            question: {
              conversationId: conversation.record.id,
              questionTurnId,
              conversationRevision: conversation.revision,
            },
          })}
        <Tabs
          label="개인 대화 기록 방식"
          value={tab}
          onValueChange={setTab}
          items={[
            {
              id: 'question',
              label: '질문 보관',
              content: (
                <QuestionForm
                  {...actions}
                  conversation={conversation}
                  initialDocument={initialDocument}
                  initialSource={initialSource}
                />
              ),
            },
            {
              id: 'answer',
              label: '외부·직접 답변 보관',
              content: <AnswerForm {...actions} conversation={conversation} />,
            },
          ]}
        />
      </div>
    </div>
  );
}

/** 불변 결과와 비교의 실제 기록·작성 당시 기준·완료 이벤트를 표시합니다. */
function RecordDetails({
  mode,
  record,
  renderQuestion,
  onQuestionChanged,
  initialDocument,
  initialSource,
  onSaveAnswer,
  ...actions
}: RecordDetailsProps): JSX.Element {
  if (mode === 'conversations')
    return (
      <Conversation
        {...actions}
        conversation={record}
        renderQuestion={renderQuestion}
        onQuestionChanged={onQuestionChanged}
        initialDocument={initialDocument}
        initialSource={initialSource}
        onSaveAnswer={onSaveAnswer}
      />
    );
  if (mode === 'savedResults') {
    const basis = readBasis(record.record.data.basis);
    return (
      <article className={styles.editor}>
        <p className={styles.eyebrow}>개인 결과 초안 · 사용자 보고</p>
        <h2>{textValue(record.record.data, 'title')}</h2>
        <p className={styles.notice}>
          저장한 내용과 당시 전체 기준을 보존한 불변 기록입니다. 위키
          게시·공유·사람 승인 상태를 뜻하지 않습니다.
        </p>
        <Link
          to={`/result-drafts?savedResultId=${encodeURIComponent(record.record.id)}`}
        >
          결과 초안 편집·Wiki 반영
        </Link>
        <small>{record.record.created_at}</small>
        <PersonalContent content={textValue(record.record.data, 'content')} />
        {basis && (
          <Button
            variant="secondary"
            onClick={(): void =>
              actions.onInspect(basis, '결과 작성 당시 전체 기준')
            }
          >
            보관된 전체 근거 보기
          </Button>
        )}
        <details>
          <summary>기록 전체·판본</summary>
          <pre>{jsonText(record)}</pre>
        </details>
      </article>
    );
  }
  const baseline = readBasis(record.record.data.baseline);
  const current = readBasis(record.record.data.current);
  const mappings = readMappings(record.record.data);
  return (
    <article className={styles.editor}>
      <p className={styles.eyebrow}>명시 선택 범위 비교 · 사용자 대응</p>
      <h2>{textValue(record.record.data, 'title')}</h2>
      <p className={styles.notice}>
        이전 결과의 기준과 비교 생성 당시 기준을 보존합니다. 자동 의미 평가와
        전체 주장 승인은 수행하지 않았습니다.
      </p>
      <div className={styles.sideBySide}>
        <div>
          <h3>이전 결과의 기준</h3>
          <p>{baseline?.documents.length || 0}개 문서 · 저장 당시</p>
          {baseline && (
            <Button
              variant="secondary"
              onClick={(): void =>
                actions.onInspect(baseline, '이전 결과의 저장 당시 기준')
              }
            >
              이전 근거 확인
            </Button>
          )}
        </div>
        <div>
          <h3>비교 생성 당시 기준</h3>
          <p>{current?.documents.length || 0}개 문서 · 현재성 미확인</p>
          {current && (
            <Button
              variant="secondary"
              onClick={(): void =>
                actions.onInspect(current, '비교 생성 당시 기준')
              }
            >
              비교 근거 확인
            </Button>
          )}
        </div>
      </div>
      <MappingCards mappings={mappings} baseline={baseline} current={current} />
      <section className={styles.history}>
        <h3>실제 비교 완료 이력</h3>
        {record.record.events.length === 0 && (
          <p className={styles.muted}>아직 완료 기록이 없습니다.</p>
        )}
        {record.record.events.map(
          (event: KnowledgeValue, index: number): JSX.Element => (
            <article key={textValue(event, 'id') || String(index)}>
              <strong>
                {event.outcome === 'reviewed'
                  ? '명시 대응 주장 검토 완료'
                  : '보류'}
              </strong>
              <small>{textValue(event, 'recorded_at')}</small>
              <p>{textValue(event, 'reason')}</p>
              <p className={styles.muted}>
                검증된 검토 참조:{' '}
                {Array.isArray(event.verified_reviews)
                  ? event.verified_reviews.length
                  : 0}
                개. 다른 주장의 승인을 뜻하지 않습니다.
              </p>
              <details>
                <summary>서버가 확인한 실제 검토 참조·전체 이벤트</summary>
                <pre>{jsonText(event)}</pre>
              </details>
            </article>
          ),
        )}
      </section>
      {current && (
        <ComparisonCompletion
          {...actions}
          comparison={record}
          current={current}
          mappings={mappings}
        />
      )}
      <details>
        <summary>스냅샷을 포함한 기록 전체·판본</summary>
        <pre>{jsonText(record)}</pre>
      </details>
    </article>
  );
}

/** 목록·기록·근거의 세 패널을 현재 개인 범위 안에서 조립합니다. */
function PersonalWorkspace({
  navigation,
  mode,
  session,
  model,
  renderQuestion,
  initialDocument,
  initialSource,
}: PersonalWorkspaceProps): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [titleDialog, setTitleDialog] = useState<
    'conversation' | 'answerResult' | null
  >(null);
  const [turnId, setTurnId] = useState('');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const title =
    mode === 'conversations'
      ? 'AI 대화 기록'
      : mode === 'savedResults'
        ? '결과물 초안'
        : '변경 비교';
  const canWrite = session.permissions.includes(writePermission(mode));
  const record = model.selected;
  let storedBasis: PersonalBasis | null = null;
  if (record) {
    if (mode === 'conversations')
      storedBasis = readBasis(record.record.events.at(-1)?.basis);
    else
      storedBasis = readBasis(
        mode === 'savedResults'
          ? record.record.data.basis
          : record.record.data.current,
      );
  }
  /** 저장된 응답의 실제 기준을 표시하며 준비 미리보기를 성공 결과로 남기지 않습니다. */
  async function mutate(
    request: PersonalMutation,
    receipt: PendingReceipt,
  ): Promise<RecordEnvelope | null> {
    const result = await model.mutate(request, receipt);
    if (result) {
      if (result.record.kind === personalKind(mode)) setInspection(null);
      else {
        const basis = readBasis(result.record.data.basis);
        if (basis)
          setInspection({ basis, label: '방금 저장한 결과의 실제 기준' });
      }
    }
    return result;
  }
  const actions: PersonalFormActions = {
    session,
    blocked: model.blocked,
    onMutate: mutate,
    onError: model.invalidate,
    onInspect: (basis: PersonalBasis, label: string): void =>
      setInspection({ basis, label }),
  };
  /** 동일 요청이 실제 저장된 경우에만 초안을 닫고 저장된 기준을 표시합니다. */
  async function confirmReceipt(): Promise<void> {
    const result = await model.confirm();
    if (!result) return;
    setCreating(false);
    setTitleDialog(null);
    setInspection(null);
    if (result.record.kind !== personalKind(mode)) {
      const basis = readBasis(result.record.data.basis);
      if (basis)
        setInspection({ basis, label: '수신 기록으로 확인한 실제 저장 기준' });
    }
  }
  const failed =
    model.write.status === 'blocked' || model.write.status === 'error'
      ? model.write
      : null;
  return (
    <div className={styles.workspace}>
      <WorkspaceToolbar className={styles.toolbar}>
        <div>
          <h1>{title}</h1>
          <p>
            개인 기록 · {session.tenant} · {session.profileId}
          </p>
        </div>
        {navigation}
        {mode === 'conversations' && (
          <Link
            to={`/work/${encodeURIComponent(session.tenant)}/question-runs`}
          >
            질문 실행 이력
          </Link>
        )}
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={model.write.status === 'saving'}
            onClick={model.refresh}
          >
            목록 새로 읽기
          </Button>
          <Button
            disabled={!canWrite || model.blocked}
            onClick={(): void => {
              if (mode === 'conversations') setTitleDialog('conversation');
              else {
                setCreating(true);
                setInspection(null);
              }
            }}
          >
            새{' '}
            {mode === 'conversations'
              ? '대화'
              : mode === 'savedResults'
                ? '결과 초안'
                : '비교'}
          </Button>
        </div>
      </WorkspaceToolbar>
      <WorkspaceLayout className={styles.panels}>
        <WorkspacePane name="index">
          <aside className={styles.index} aria-label="개인 기록 목록">
            <header className={styles.panelHeader}>
              <h2>{title}</h2>
              <span>나에게만 보임</span>
            </header>
            <div className={styles.recordList}>
              {model.page.status === 'loading' ? (
                <div className={styles.empty}>기록을 읽고 있습니다.</div>
              ) : model.page.status === 'error' ? (
                <StatusNotice tone="error">
                  {model.page.error.message}
                  <Button variant="secondary" onClick={model.refresh}>
                    다시 읽기
                  </Button>
                </StatusNotice>
              ) : (
                <>
                  {model.page.data.items.length === 0 && (
                    <div className={styles.empty}>
                      저장된 개인 기록이 없습니다.
                    </div>
                  )}
                  {model.page.data.items.map(
                    (item: PersonalPage['items'][number]): JSX.Element => (
                      <button
                        type="button"
                        key={item.id}
                        className={
                          record?.record.id === item.id && !creating
                            ? styles.selectedRecord
                            : styles.record
                        }
                        disabled={model.blocked}
                        onClick={(): void => {
                          setCreating(false);
                          setInspection(null);
                          model.select(item.id);
                        }}
                      >
                        <strong>{item.title}</strong>
                        <small>{item.created_at}</small>
                        <span>
                          {mode === 'conversations'
                            ? '질문·답변·근거 기록'
                            : mode === 'savedResults'
                              ? '저장 당시 기준 보존'
                              : '명시 대응 비교'}
                        </span>
                      </button>
                    ),
                  )}
                  {record &&
                    !model.page.data.items.some(
                      (item: PersonalPage['items'][number]): boolean =>
                        item.id === record.record.id,
                    ) && (
                      <div className={styles.pinnedRecord}>
                        선택 중: {textValue(record.record.data, 'title')}
                        <small>현재 목록 페이지 밖의 실제 선택 기록</small>
                      </div>
                    )}
                  {(model.page.data.truncated ||
                    model.page.data.skipped.length > 0 ||
                    !model.page.data.complete) && (
                    <StatusNotice tone="warning">
                      목록 일부를 읽지 못했습니다.
                    </StatusNotice>
                  )}
                </>
              )}
            </div>
            <footer className={styles.pagination}>
              <Button
                variant="secondary"
                disabled={
                  model.pageIndex === 0 ||
                  model.page.status === 'loading' ||
                  model.blocked
                }
                onClick={model.previous}
              >
                이전
              </Button>
              <span>{model.pageIndex + 1}쪽</span>
              <Button
                variant="secondary"
                disabled={
                  model.page.status !== 'ready' ||
                  !model.page.data.next_cursor ||
                  model.blocked
                }
                onClick={model.next}
              >
                다음
              </Button>
            </footer>
          </aside>
        </WorkspacePane>
        <WorkspacePane name="content">
          <main className={styles.center} aria-label={title}>
            {!canWrite && (
              <StatusNotice title="개인 기록 읽기 권한으로 보고 있습니다">
                이 화면의 저장에는 별도 {writePermission(mode)} 권한이
                필요합니다.
              </StatusNotice>
            )}
            {model.write.status === 'saving' && (
              <StatusNotice title="개인 기록을 저장하고 있습니다" />
            )}
            {model.write.status === 'saved' && (
              <StatusNotice tone="success">{model.write.message}</StatusNotice>
            )}
            {failed && (
              <StatusNotice
                tone={model.write.status === 'blocked' ? 'warning' : 'error'}
                title={
                  failed.error.code === 'outcome_unknown'
                    ? '저장 결과 미확인'
                    : failed.error.code === 'conflict' ||
                        failed.error.status === 409
                      ? '다른 변경과 충돌했습니다'
                      : '요청을 완료하지 못했습니다'
                }
              >
                <p>{failed.error.message}</p>
                {failed.error.traceId && (
                  <small>문의 코드: {failed.error.traceId}</small>
                )}
                {model.write.status === 'blocked' && (
                  <>
                    <p>
                      초안을 보존했습니다. 판본을 바꿔 자동 재저장하지 않습니다.
                    </p>
                    <div className={styles.actions}>
                      {model.write.receipt ? (
                        <Button
                          variant="secondary"
                          onClick={(): void => {
                            void confirmReceipt();
                          }}
                        >
                          동일 요청의 수신 기록 조회
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            onClick={model.inspect}
                            disabled={!record}
                          >
                            현재 기록 읽기·수동 대조
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={(): void => {
                              setCreating(false);
                              setTitleDialog(null);
                              setInspection(null);
                              model.discardAndReload();
                            }}
                          >
                            초안 닫고 현재 기록 다시 선택
                          </Button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </StatusNotice>
            )}
            {model.inspection && (
              <section className={styles.collision}>
                <h3>충돌 후 읽은 현재 기록 · 대조 전용</h3>
                <p>이 기록은 초안의 기준 판본으로 자동 적용하지 않습니다.</p>
                <pre>{jsonText(model.inspection)}</pre>
              </section>
            )}
            {creating ? (
              mode === 'savedResults' ? (
                <DirectResultForm
                  {...actions}
                  onCancel={(): void => setCreating(false)}
                  onSaved={(): void => setCreating(false)}
                />
              ) : (
                <ComparisonCreateForm
                  {...actions}
                  onCancel={(): void => setCreating(false)}
                  onSaved={(): void => setCreating(false)}
                />
              )
            ) : record ? (
              <RecordDetails
                key={
                  mode === 'conversations'
                    ? record.record.id
                    : `${record.record.id}:${record.revision}`
                }
                {...actions}
                mode={mode}
                record={record}
                renderQuestion={renderQuestion}
                onQuestionChanged={model.refreshSelected}
                initialDocument={initialDocument}
                initialSource={initialSource}
                onSaveAnswer={(id: string): void => {
                  setTurnId(id);
                  setTitleDialog('answerResult');
                }}
              />
            ) : (
              <div className={styles.chatEmpty}>
                <strong>
                  {mode === 'conversations'
                    ? '축적한 지식으로 무엇을 알아볼까요?'
                    : mode === 'savedResults'
                      ? '근거와 함께 결과를 보관하세요'
                      : '저장한 결과와 현재 근거를 대조하세요'}
                </strong>
                <p>왼쪽의 실제 기록을 선택하거나 새 개인 기록을 시작하세요.</p>
                <span>현재 사용자 소유 기록만 조회됩니다.</span>
              </div>
            )}
          </main>
        </WorkspacePane>
        <WorkspacePane name="inspector">
          <BasisInspector
            basis={inspection ? inspection.basis : storedBasis}
            label={
              inspection
                ? inspection.label
                : record
                  ? '실제 기록에 보관된 당시 기준'
                  : '근거 선택 대기'
            }
          />
        </WorkspacePane>
      </WorkspaceLayout>
      {titleDialog && (
        <PersonalTitleDialog
          {...actions}
          kind={titleDialog}
          conversation={record || undefined}
          turnId={turnId || undefined}
          onClose={(): void => setTitleDialog(null)}
          writeState={model.write}
          onConfirmReceipt={(): void => {
            void confirmReceipt();
          }}
          onDiscardConflict={(): void => {
            setTitleDialog(null);
            setInspection(null);
            model.discardAndReload();
          }}
        />
      )}
    </div>
  );
}

/** 현재 연결이 정한 개인 범위를 읽은 뒤에만 기록 화면과 입력을 엽니다. */
export function ManagePersonalRecords({
  navigation,
  mode,
  renderQuestion,
  initialDocument,
  initialSource,
}: ManagePersonalRecordsProps): JSX.Element {
  const model = usePersonalRecords(mode);
  if (model.session.status === 'loading')
    return (
      <div>
        {navigation}
        <StatusNotice title="현재 사용자와 개인 기록 범위를 확인하고 있습니다" />
      </div>
    );
  if (model.session.status === 'error')
    return (
      <div>
        {navigation}
        <StatusNotice tone="error" title="개인 기록을 열 수 없습니다">
          {model.session.error.message}
        </StatusNotice>
      </div>
    );
  const scope = model.session.data;
  return (
    <PersonalWorkspace
      navigation={navigation}
      renderQuestion={renderQuestion}
      initialDocument={initialDocument}
      initialSource={initialSource}
      key={JSON.stringify([
        mode,
        scope.connectionId,
        scope.userId,
        scope.tenant,
        scope.profileId,
        scope.policyRevision,
      ])}
      mode={mode}
      session={scope}
      model={model}
    />
  );
}
