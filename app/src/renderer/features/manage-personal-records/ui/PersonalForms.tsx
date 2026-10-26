import { useState } from 'react';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  titleFormSchema,
  questionFormSchema,
  resultFormSchema,
  answerFormSchema,
} from '../model/personalForms';
import type {
  TitleFormValues,
  QuestionFormValues,
  QuestionSource,
  ResultFormValues,
  AnswerFormValues,
} from '../model/personalForms';
import { newRequestId, textValue } from '../model/personalRecords';
import type {
  PersonalBasis,
  PersonalSession,
  PersonalError,
  PersonalMutation,
  PendingReceipt,
  RecordEnvelope,
  PersonalWriteState,
} from '../model/personalRecords';
import { ContextPicker, ContextPreparation } from './ContextPicker';
import styles from './ManagePersonalRecords.module.scss';

export type PersonalFormActions = {
  session: PersonalSession;
  blocked: boolean;
  onMutate: (
    request: PersonalMutation,
    receipt: PendingReceipt,
  ) => Promise<RecordEnvelope | null>;
  onError: (error: PersonalError) => void;
  onInspect: (basis: PersonalBasis, label: string) => void;
};
type TitleDialogProps = PersonalFormActions & {
  kind: 'conversation' | 'answerResult';
  conversation?: RecordEnvelope;
  turnId?: string;
  onClose: () => void;
  writeState: PersonalWriteState;
  onConfirmReceipt: () => void;
  onDiscardConflict: () => void;
};
/** 실제 대화를 만들거나 선택된 완성 답변을 불변 결과 초안으로 보관합니다. */
export function PersonalTitleDialog({
  session,
  blocked,
  onMutate,
  kind,
  conversation,
  turnId,
  onClose,
  writeState,
  onConfirmReceipt,
  onDiscardConflict,
}: TitleDialogProps): JSX.Element {
  const form = useForm<TitleFormValues>({
    resolver: zodResolver(titleFormSchema),
    defaultValues: { title: '' },
  });
  /** 값과 요청 식별자는 사용자 입력과 분리해 명시한 한 번의 저장에만 사용합니다. */
  async function submit(values: TitleFormValues): Promise<void> {
    const requestId = newRequestId();
    const result =
      kind === 'conversation'
        ? await onMutate(
            {
              connectionId: session.connectionId,
              operation: 'createConversation',
              input: { request_id: requestId, title: values.title },
            },
            { kind: 'conversations', requestId },
          )
        : conversation && turnId
          ? await onMutate(
              {
                connectionId: session.connectionId,
                operation: 'createSavedResult',
                input: {
                  request_id: requestId,
                  title: values.title,
                  conversation_id: conversation.record.id,
                  turn_id: turnId,
                },
              },
              { kind: 'saved-results', requestId },
            )
          : null;
    if (result) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open: boolean): void => {
        if (!open && !blocked) onClose();
      }}
      title={
        kind === 'conversation' ? '새 개인 대화' : '답변을 결과 초안으로 보관'
      }
      description="현재 사용자에게만 보이는 개인 기록입니다."
    >
      {(writeState.status === 'blocked' || writeState.status === 'error') && (
        <StatusNotice
          tone="warning"
          title={
            writeState.error.code === 'outcome_unknown'
              ? '저장 결과 미확인'
              : '기록을 저장하지 못했습니다'
          }
        >
          <p>{writeState.error.message}</p>
          {writeState.status === 'blocked' &&
            (writeState.receipt ? (
              <Button variant="secondary" onClick={onConfirmReceipt}>
                동일 요청의 수신 기록 조회
              </Button>
            ) : (
              <>
                <p>
                  초안을 보존했습니다. 현재 기록을 대조한 뒤 새로 선택해야
                  합니다.
                </p>
                <Button variant="secondary" onClick={onDiscardConflict}>
                  초안 닫고 현재 기록 확인
                </Button>
              </>
            ))}
        </StatusNotice>
      )}
      <form className={styles.form} onSubmit={form.handleSubmit(submit)}>
        <label>
          제목
          <input
            {...form.register('title')}
            maxLength={200}
            disabled={blocked}
            autoFocus
          />
        </label>
        <p className={styles.error}>{form.formState.errors.title?.message}</p>
        <p className={styles.muted}>
          {kind === 'conversation'
            ? '질문과 외부에서 작성한 답변을 실제 근거와 함께 보관합니다.'
            : '선택한 실제 답변과 그 답변이 참조한 질문 당시 기준 전체를 보관합니다. 위키 게시나 사람의 승인을 뜻하지 않습니다.'}
        </p>
        <Button type="submit" disabled={blocked}>
          개인 기록 저장
        </Button>
      </form>
    </Dialog>
  );
}

type DirectResultFormProps = PersonalFormActions & {
  onCancel: () => void;
  onSaved: () => void;
};
/** 직접 작성한 결과와 저장 당시 전체 근거를 개인 불변 초안으로 저장합니다. */
export function DirectResultForm({
  session,
  blocked,
  onMutate,
  onError,
  onInspect,
  onCancel,
  onSaved,
}: DirectResultFormProps): JSX.Element {
  const form = useForm<ResultFormValues>({
    resolver: zodResolver(resultFormSchema),
    defaultValues: { title: '', content: '', documents: [] },
  });
  const documents = useWatch({ control: form.control, name: 'documents' });
  const [prepared, setPrepared] = useState<PersonalBasis | null>(null);
  /** 준비된 범위가 있을 때만 실제 직접 작성 결과 API를 호출합니다. */
  async function submit(values: ResultFormValues): Promise<void> {
    if (!prepared) return;
    const requestId = newRequestId();
    const result = await onMutate(
      {
        connectionId: session.connectionId,
        operation: 'createSavedResult',
        input: {
          request_id: requestId,
          title: values.title,
          content: values.content,
          context_request: {
            documents: values.documents,
            required_documents: values.documents,
          },
        },
      },
      { kind: 'saved-results', requestId },
    );
    if (result) onSaved();
  }
  return (
    <div className={styles.editor}>
      <header>
        <h2>결과물 초안</h2>
        <p>
          직접 작성하거나 외부에서 받은 내용을 근거와 함께 개인 기록으로
          보관합니다.
        </p>
      </header>
      <form className={styles.form} onSubmit={form.handleSubmit(submit)}>
        <label>
          초안 제목
          <input
            {...form.register('title')}
            disabled={blocked}
            maxLength={200}
          />
        </label>
        <p className={styles.error}>{form.formState.errors.title?.message}</p>
        <label>
          보관할 내용
          <textarea
            {...form.register('content')}
            disabled={blocked}
            rows={12}
            maxLength={65536}
            placeholder="외부에서 받은 답변 또는 직접 작성한 내용을 입력하세요."
          />
        </label>
        <p className={styles.error}>{form.formState.errors.content?.message}</p>
        <ContextPicker
          session={session}
          documents={documents}
          disabled={blocked}
          onError={onError}
          onChange={(value: string[]): void => {
            form.setValue('documents', value, { shouldValidate: true });
            setPrepared(null);
          }}
        />
        <p className={styles.error}>
          {form.formState.errors.documents?.message}
        </p>
        <ContextPreparation
          key={JSON.stringify(documents)}
          session={session}
          documents={documents}
          disabled={blocked}
          onError={onError}
          onPrepared={(basis: PersonalBasis): void => {
            setPrepared(basis);
            onInspect(basis, '저장 전 준비 조회');
          }}
        />
        {prepared && (
          <p className={styles.success}>
            선택한 근거 준비를 확인했습니다. 저장 후 실제 보관 기준을
            확인하세요.
          </p>
        )}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={blocked} onClick={onCancel}>
            초안 닫기
          </Button>
          <Button
            type="submit"
            disabled={
              blocked ||
              !prepared ||
              !session.permissions.includes('result_write')
            }
          >
            개인 결과로 보관
          </Button>
        </div>
      </form>
    </div>
  );
}

type QuestionFormProps = PersonalFormActions & {
  conversation: RecordEnvelope;
  initialDocument?: string;
  initialSource?: QuestionSource;
};
/** 질문을 실행한 것처럼 표시하지 않고 실제 질문과 근거를 대화에 저장합니다. */
export function QuestionForm({
  session,
  blocked,
  onMutate,
  onError,
  onInspect,
  conversation,
  initialDocument,
  initialSource,
}: QuestionFormProps): JSX.Element {
  const form = useForm<QuestionFormValues>({
    resolver: zodResolver(questionFormSchema),
    defaultValues: {
      content: '',
      documents: initialDocument ? [initialDocument] : [],
      sources: initialSource ? [initialSource] : [],
    },
  });
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const documents = useWatch({ control: form.control, name: 'documents' });
  const sources = useWatch({ control: form.control, name: 'sources' });
  const [prepared, setPrepared] = useState<PersonalBasis | null>(null);
  /** 편집을 시작한 대화 판본을 고정하며 저장 충돌 때 교체하지 않습니다. */
  async function submit(values: QuestionFormValues): Promise<void> {
    if (!prepared) return;
    const requestId = newRequestId();
    const result = await onMutate(
      {
        connectionId: session.connectionId,
        operation: 'appendTurn',
        input: {
          record_id: conversation.record.id,
          request_id: requestId,
          expected_revision: draftRevision ?? conversation.revision,
          role: 'user',
          content: values.content,
          status: 'complete',
          context_request: {
            documents: values.documents,
            required_documents: values.documents,
            source_refs: values.sources,
          },
        },
      },
      { kind: 'conversations', requestId, recordId: conversation.record.id },
    );
    if (result) {
      form.reset();
      setDraftRevision(null);
      setPrepared(null);
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={form.handleSubmit(submit)}
      onChange={(): void => {
        setDraftRevision(
          (revision: string | null): string =>
            revision ?? conversation.revision,
        );
      }}
    >
      {draftRevision && draftRevision !== conversation.revision && (
        <p role="status">
          새 답변이 추가되었습니다. 작성 중인 질문과 저장 기준은 보존했습니다.
          저장 시 현재 대화와 충돌하면 내용을 대조해 주세요.
        </p>
      )}
      <label>
        근거와 함께 보관할 질문
        <textarea
          {...form.register('content')}
          rows={3}
          maxLength={65536}
          disabled={blocked}
          placeholder="지식에 대해 알아볼 질문을 입력하세요."
        />
      </label>
      <p className={styles.error}>{form.formState.errors.content?.message}</p>
      <details>
        <summary>
          질문에 사용할 자료 선택 (문서 {documents.length}/8 · 원본{' '}
          {sources.length}/4)
        </summary>
        <ContextPicker
          session={session}
          documents={documents}
          sources={sources}
          onSourcesChange={(value: QuestionSource[]): void => {
            form.setValue('sources', value, { shouldValidate: true });
            setPrepared(null);
          }}
          disabled={blocked}
          onError={onError}
          onChange={(value: string[]): void => {
            form.setValue('documents', value, { shouldValidate: true });
            setPrepared(null);
          }}
        />
      </details>
      <p className={styles.error}>{form.formState.errors.documents?.message}</p>
      <ContextPreparation
        key={JSON.stringify([documents, sources])}
        session={session}
        documents={documents}
        sources={sources}
        disabled={blocked}
        onError={onError}
        onPrepared={(basis: PersonalBasis): void => {
          setPrepared(basis);
          onInspect(basis, '질문 저장 전 준비 조회');
        }}
      />
      <div className={styles.actions}>
        <small>
          질문과 근거를 먼저 저장합니다. 저장된 질문에서 개인 AI 실행을
          명시적으로 시작할 수 있습니다.
        </small>
        <Button
          type="submit"
          disabled={
            blocked ||
            !prepared ||
            !session.permissions.includes('conversation_write')
          }
        >
          질문 기록 저장
        </Button>
      </div>
    </form>
  );
}

type AnswerFormProps = PersonalFormActions & { conversation: RecordEnvelope };
/** 저장된 질문을 실제 참조하는 외부·직접 작성 답변을 client_reported로 보관합니다. */
export function AnswerForm({
  session,
  blocked,
  onMutate,
  conversation,
}: AnswerFormProps): JSX.Element {
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const questions = conversation.record.events.filter(
    (event: RecordEnvelope['record']['events'][number]): boolean =>
      event.role === 'user' && typeof event.id === 'string',
  );
  const form = useForm<AnswerFormValues>({
    resolver: zodResolver(answerFormSchema),
    defaultValues: {
      replyTo: questions.length
        ? textValue(questions[questions.length - 1] || {}, 'id')
        : '',
      content: '',
      status: 'complete',
    },
  });
  /** 답변에는 질문의 실제 ID를 연결하며 질문의 기준 스냅샷은 서버가 복사합니다. */
  async function submit(values: AnswerFormValues): Promise<void> {
    if (
      !questions.some(
        (event: RecordEnvelope['record']['events'][number]): boolean =>
          event.id === values.replyTo,
      )
    )
      return;
    const requestId = newRequestId();
    const result = await onMutate(
      {
        connectionId: session.connectionId,
        operation: 'appendTurn',
        input: {
          record_id: conversation.record.id,
          request_id: requestId,
          expected_revision: draftRevision ?? conversation.revision,
          role: 'assistant',
          content: values.content,
          status: values.status,
          reply_to: values.replyTo,
        },
      },
      { kind: 'conversations', requestId, recordId: conversation.record.id },
    );
    if (result) {
      form.reset();
      setDraftRevision(null);
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={form.handleSubmit(submit)}
      onChange={(): void => {
        setDraftRevision(
          (revision: string | null): string =>
            revision ?? conversation.revision,
        );
      }}
    >
      <p className={styles.notice}>
        외부 도구에서 받은 답변 또는 직접 작성한 답변을 보관합니다. 서버가
        생성한 AI 응답이 아니며 검토·승인을 뜻하지 않습니다.
      </p>
      <label>
        답변할 저장 질문
        <select
          {...form.register('replyTo')}
          disabled={blocked || questions.length === 0}
        >
          <option value="">질문 선택</option>
          {questions.map(
            (
              event: RecordEnvelope['record']['events'][number],
            ): JSX.Element => (
              <option
                key={textValue(event, 'id')}
                value={textValue(event, 'id')}
              >
                {textValue(event, 'content').slice(0, 120)}
              </option>
            ),
          )}
        </select>
      </label>
      <p className={styles.error}>{form.formState.errors.replyTo?.message}</p>
      <label>
        답변 내용
        <textarea
          {...form.register('content')}
          rows={5}
          maxLength={65536}
          disabled={blocked}
        />
      </label>
      <p className={styles.error}>{form.formState.errors.content?.message}</p>
      <label>
        답변 상태
        <select {...form.register('status')} disabled={blocked}>
          <option value="complete">내용 보관</option>
          <option value="failed">외부 응답 실패 기록</option>
        </select>
      </label>
      <Button
        type="submit"
        disabled={
          blocked ||
          questions.length === 0 ||
          !session.permissions.includes('conversation_write')
        }
      >
        외부·직접 답변 저장
      </Button>
    </form>
  );
}
