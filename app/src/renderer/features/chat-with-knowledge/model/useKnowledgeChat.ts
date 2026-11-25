import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { QuestionDetail } from '@contracts/questionRuns.contract';
import { useAiConnection } from '@renderer/platform/aiConnection';
import type { RuntimeSnapshot } from '@contracts/runtime.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import { isDocumentPath } from '@contracts/documents.contract';
import { createChatRecovery } from '../api/chatRecovery';
import { composeQuestion } from './externalMaterial';
import { webBasisSummary } from './chatCitations';
import {
  fitAttachment,
  nextPastedName,
  remainingCapacity,
} from './attachments';
import type { ChatAttachment } from './attachments';
import { useSessionAvailability } from './useSessionAvailability';
import { useAnswerArtifacts } from './useAnswerArtifacts';
import { templateById } from './answerTemplates';
import { templatesGateway } from '@renderer/platform/templates';
import { freezeTemplate, registeredTemplateId } from './templateSnapshot';
import { splitQuestion } from './externalMaterial';
import {
  ChatRequestError,
  chatRunsApi,
  readChatRuntime,
  selectChatModel,
  requestChat,
  runChat,
} from '../api/knowledgeChat.api';
import type { AnswerArtifact, ChatAccess } from '../api/knowledgeChat.api';
import {
  chatEnvelopeSchema,
  chatAwaitingClarification,
  chatId,
  chatQuestionSchema,
  chatRunActive,
  chatRunStartable,
  chatRunUncertain,
  chatTurns,
  emptyChat,
} from './chatState';
import type {
  ChatEnvelope,
  ChatPending,
  ChatRecovery,
  ChatThread,
  ChatTurn,
} from './chatState';
import {
  canAdvanceChatDraft,
  mergeChatRunLocal,
  rememberChatRunNotice,
} from './chatRunFeedback';
import { visibleSubmittedQuestion } from './chatTranscript';
import type {
  SubmittedChatDraft,
  SubmittedChatQuestion,
} from './chatTranscript';

export type KnowledgeChatModel = {
  thread: ChatThread;
  threads: ChatThread[];
  conversation: ChatEnvelope | null;
  run: QuestionDetail | null;
  /** 마지막 서버 메시지가 명시한 추가 질문입니다. 진행 문장으로 추측하지 않습니다. */
  clarification: ChatTurn | null;
  /** 서버 저장 전에도 방금 보낸 질문을 보여 주는 표시 전용 상태입니다. */
  submittedQuestion: SubmittedChatQuestion | null;
  busy: boolean;
  loading: boolean;
  ready: boolean;
  invalidScope: boolean;
  phase: string;
  /** 이번 질문에서 찾은 문서 수입니다. 찾는 중이면 null입니다. */
  foundCount: number | null;
  error: string;
  recoveryNotice: string;
  runtime: RuntimeSnapshot | null;
  /** 이 PC에서 이어 갈 AI 세션이 있는지입니다. 확인 전·불가·실패는 null입니다. */
  resumable: boolean | null;
  /** 입력창에서 고른 모델을 바로 저장해 다음 질문부터 씁니다. */
  selectModel: (value: string) => Promise<void>;
  pending: ChatPending | null;
  setDraft: (value: string) => void;
  /** 붙여넣은 글이나 파일에서 읽은 글을 첨부 칩으로 더합니다. 한도를 넘으면 앞부분만 담고 알립니다. */
  addAttachment: (draft: {
    kind: ChatAttachment['kind'];
    name?: string;
    text: string;
    truncated?: boolean;
  }) => 'added' | 'truncated' | 'full';
  attachmentRoom: () => number;
  removeAttachment: (id: string) => void;
  setTemplate: (value: string) => void;
  setWebEnabled: (value: boolean) => void;
  setWebQuery: (value: string) => void;
  send: () => Promise<void>;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => Promise<void>;
  newChat: (document?: string) => ChatThread | null;
  selectChat: (id: string) => ChatThread | null;
  openConversation: (
    id: string,
    questionRunId?: string,
  ) => Promise<ChatThread | null>;
  clearDocumentScope: () => void;
  diagnose: () => Promise<void>;
  acknowledgeConversation: () => void;
  retryRecovery: () => void;
  ensureAnswerArtifact: (turn: ChatTurn) => Promise<AnswerArtifact | null>;
};

/** 질문·접수 요청을 보호 저장하고 조회만으로 CLI를 재실행하지 않습니다. */
export function useKnowledgeChat(
  access: ChatAccess,
  onArtifact: (id: string) => void,
): KnowledgeChatModel {
  const { session } = access;
  const recovery = useMemo(
    (): ReturnType<typeof createChatRecovery> => createChatRecovery(session),
    [session],
  );
  const [state, setState] = useState<ChatRecovery>((): ChatRecovery => {
    const thread = emptyChat();
    return { activeId: thread.id, threads: [thread], pending: null };
  });
  const stateRef = useRef(state);
  const [conversation, setConversation] = useState<ChatEnvelope | null>(null);
  const conversationRef = useRef<ChatEnvelope | null>(null);
  const [run, setRun] = useState<QuestionDetail | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedChatDraft | null>(null);
  const runtime = useAiConnection.useSnapshot();
  const [ready, setReady] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [loadedThread, setLoadedThread] = useState('');
  const loading = ready && loadedThread !== state.activeId;
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  // 이번 질문에서 찾은 문서 수입니다. 찾는 중이거나 질문이 없으면 null이며 저장하지 않습니다.
  const [foundCount, setFoundCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [invalidScope, setInvalidScope] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const readSerial = useRef(0);
  const selected = state.threads.find(
    (item: ChatThread): boolean => item.id === state.activeId,
  );
  const thread = selected ?? state.threads[0];
  if (!thread) throw new Error('대화 복구 항목이 없습니다.');
  const ensureAnswerArtifact = useAnswerArtifacts(
    access,
    conversation,
    thread.title,
  );

  /** 입력 직후의 값도 같은 요청에 고정하며 React 렌더 지연에 의존하지 않습니다. */
  function update(next: ChatRecovery): void {
    stateRef.current = next;
    if (alive.current) setState(next);
  }
  /** 대상 대화의 초안만 바꾸며 이전 대화와 미확인 요청을 보존합니다. */
  function patchThread(patch: Partial<ChatThread>): void {
    const current = stateRef.current;
    update({
      ...current,
      threads: current.threads.map((item: ChatThread): ChatThread =>
        item.id === current.activeId ? { ...item, ...patch } : item,
      ),
    });
  }
  /** 실제 대화 조회의 이전 판본을 초안 기준 검증에만 보관합니다. */
  function acceptConversation(value: ChatEnvelope | null): void {
    conversationRef.current = value;
    setConversation(value);
  }
  /** 같은 질문의 종료 상태를 보호 저장에 남겨 다음 질문 뒤에도 확인할 수 있게 합니다. */
  function acceptRun(detail: QuestionDetail | null): void {
    setRun((previous: QuestionDetail | null): QuestionDetail | null =>
      mergeChatRunLocal(detail, previous?.id, previous?.local),
    );
    if (!detail) return;
    const current = stateRef.current.threads.find(
      (item: ChatThread): boolean => item.id === stateRef.current.activeId,
    );
    if (
      !current ||
      current.conversationId !== detail.conversationId ||
      current.runId !== detail.id ||
      current.questionTurnId !== detail.questionTurnId
    )
      return;
    const runNotices = rememberChatRunNotice(current.runNotices, detail);
    if (JSON.stringify(runNotices) !== JSON.stringify(current.runNotices))
      patchThread({ runNotices });
  }
  /** 종료 전에 요청 ID를 먼저 보존하며 복구 저장 실패 시 쓰기를 시작하지 않습니다. */
  async function preservePending(pending: ChatPending | null): Promise<void> {
    const previous = stateRef.current.pending;
    const next = { ...stateRef.current, pending };
    update(next);
    try {
      await recovery.save(next);
    } catch (reason: unknown) {
      // 보존 실패 전에는 POST를 보내지 않습니다. 저장 후 clear 실패는 이전 pending을 남깁니다.
      update({ ...stateRef.current, pending: previous });
      setRecoveryNotice(
        '보호 저장을 확인하지 못했습니다. 현재 질문은 메모리에 보존했습니다.',
      );
      throw reason;
    }
  }
  /** 권한 변경 시 이전 본문을 감추고 다른 범위로 재요청하지 않습니다. */
  function fail(reason: unknown): void {
    if (!alive.current) return;
    const code = reason instanceof ChatRequestError ? reason.code : '';
    if (
      [
        'scope_changed',
        'connection_changed',
        'forbidden',
        'unauthorized',
        'access_changed',
      ].includes(code)
    ) {
      setInvalidScope(true);
      acceptConversation(null);
      acceptRun(null);
      setSubmitted(null);
    }
    setError(
      reason instanceof Error ? reason.message : '응답을 확인하지 못했습니다.',
    );
  }
  /** 비동기 작업을 한 번만 시작하고 실패해도 질문과 기존 답변을 그대로 둡니다. */
  async function perform(operation: () => Promise<void>): Promise<void> {
    if (locked.current || !ready || invalidScope) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason: unknown) {
      fail(reason);
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        setPhase('');
      }
    }
  }
  /** 소유 범위와 요청 ID를 확인한 개인 기록만 화면에 받아들입니다. */
  function record(
    value: KnowledgeValue,
    kind: 'conversations' | 'saved-results',
    requestId?: string,
  ): ChatEnvelope {
    const result = chatEnvelopeSchema.parse(value);
    if (
      result.record.kind !== kind ||
      result.record.tenant !== session.expectedScope.tenant ||
      result.record.user_id !== session.expectedScope.userId ||
      (requestId && !result.record.requests[requestId])
    )
      throw new ChatRequestError(
        'outcome_unknown',
        '동일 요청의 저장 기록을 확인하지 못했습니다.',
        undefined,
        true,
      );
    if (kind === 'conversations') chatTurns(result);
    return result;
  }
  /** 실제 저장된 대화만 다시 읽으며 새 질문이나 답변을 만들지 않습니다. */
  async function readConversation(id: string): Promise<ChatEnvelope> {
    const value = record(
      await requestChat({
        ...session,
        operation: 'conversation',
        input: { record_id: id },
      }),
      'conversations',
    );
    if (value.record.id !== id)
      throw new ChatRequestError(
        'invalid_response',
        '다른 대화의 응답을 받았습니다.',
      );
    return value;
  }
  /** 같은 요청의 복구 기록을 먼저 보존하고, 확정 거절만 미확인 표시에서 해제합니다. */
  async function requestPending<T>(
    pending: ChatPending,
    operation: () => Promise<T>,
  ): Promise<T> {
    await preservePending(pending);
    try {
      return await operation();
    } catch (reason: unknown) {
      if (
        reason instanceof ChatRequestError &&
        !reason.unknownOutcome &&
        reason.status !== undefined &&
        reason.status >= 400 &&
        reason.status < 500 &&
        reason.code !== 'invalid_response'
      )
        await preservePending(null);
      throw reason;
    }
  }
  /** 저장 응답도 같은 요청·소유 범위로 검증한 뒤에만 받아들입니다. */
  function write(
    request: WorkspaceRequest,
    pending: ChatPending,
  ): Promise<ChatEnvelope> {
    return requestPending(pending, async (): Promise<ChatEnvelope> =>
      record(
        await requestChat(request),
        pending.step === 'artifact' ? 'saved-results' : 'conversations',
        pending.requestId,
      ),
    );
  }
  /** 질문 실행을 접수한 뒤 별도 시작 명령을 보내며 시작 실패에도 ID를 유지합니다. */
  async function createRun(
    current: ChatEnvelope,
    questionTurnId: string,
  ): Promise<void> {
    const requestId = chatId();
    const detail = await requestPending(
      {
        step: 'run',
        requestId,
        recordId: null,
        threadId: stateRef.current.activeId,
      },
      async (): Promise<QuestionDetail> => {
        setPhase('질문을 보내고 있어요');
        return await runChat((): ReturnType<typeof chatRunsApi.create> =>
          chatRunsApi.create({
            ...session,
            requestId,
            conversationId: current.record.id,
            questionTurnId,
            conversationRevision: current.revision,
            interactionContract: 'user-input-v1',
          }),
        );
      },
    );
    patchThread({ runId: detail.id });
    if (alive.current) acceptRun(detail);
    await preservePending(null);
    await startRun(detail);
  }
  /** 시작 응답 유실은 같은 실행을 다시 읽을 때까지 새 전송과 대화 전환을 잠급니다. */
  async function startRun(detail: QuestionDetail): Promise<void> {
    patchThread({ startUnconfirmed: true });
    await recovery.save(stateRef.current);
    setPhase('AI가 답변을 준비하고 있어요');
    const started = await runChat((): ReturnType<typeof chatRunsApi.start> =>
      chatRunsApi.start({
        ...session,
        questionRunId: detail.id,
        expectedStateRevision: detail.stateRevision,
        reclaim:
          detail.status === 'running' && detail.leaseStatus === 'expired',
      }),
    );
    if (alive.current) acceptRun(started);
    patchThread({ startUnconfirmed: false });
  }

  /** 서버가 저장한 추가 질문에 원문 답변을 붙이며 근거·자료·템플릿은 서버가 승계합니다. */
  async function replyToClarification(clarification: ChatTurn): Promise<void> {
    if (!thread.conversationId)
      throw new Error('답변할 대화를 다시 확인해 주세요.');
    const content = thread.draft;
    if (content.length > 16000)
      throw new Error('답변은 16,000자 이내로 입력해 주세요.');
    const questionTurnId = chatId();
    readSerial.current += 1;
    setSubmitted({ id: questionTurnId, content, threadId: thread.id });
    setFoundCount(null);
    setPhase('답변을 보내고 있어요');
    let current = await readConversation(thread.conversationId);
    if (
      chatAwaitingClarification(current)?.id !== clarification.id ||
      (thread.draftRevision && thread.draftRevision !== current.revision)
    ) {
      acceptConversation(current);
      throw new Error(
        '답변 작성 중 대화가 변경되었습니다. 갱신된 대화를 확인한 뒤 다시 보내 주세요.',
      );
    }
    current = await write(
      {
        ...session,
        operation: 'appendTurn',
        input: {
          record_id: current.record.id,
          request_id: questionTurnId,
          expected_revision: thread.draftRevision ?? current.revision,
          role: 'user',
          content,
          status: 'complete',
          clarification_turn_id: clarification.id,
        },
      },
      {
        step: 'question',
        sentQuestion: content,
        requestId: questionTurnId,
        recordId: current.record.id,
        threadId: thread.id,
      },
    );
    patchThread({
      draft: '',
      draftRevision: null,
      questionTurnId,
      runId: null,
    });
    if (alive.current) {
      acceptConversation(current);
      acceptRun(null);
      setSubmitted(null);
    }
    await preservePending(null);
    await createRun(current, questionTurnId);
  }

  /** 검색과 고정 근거 준비가 성공한 질문만 저장 후 명시 실행합니다. */
  async function send(): Promise<void> {
    await perform(async (): Promise<void> => {
      if (
        stateRef.current.pending ||
        thread.startUnconfirmed ||
        chatRunActive(run) ||
        (run && chatRunUncertain(run))
      )
        throw new Error('이전 요청의 저장 상태를 먼저 확인해 주세요.');
      if (!access.permissions.includes('conversation_write'))
        throw new Error('현재 작업 공간에 대화 작성 권한이 없습니다.');
      const question = chatQuestionSchema.parse({
        question: thread.draft,
      }).question;
      const clarification = chatAwaitingClarification(conversationRef.current);
      if (clarification) {
        await replyToClarification(clarification);
        return;
      }
      const attachments = thread.attachments;
      // 저장·전송하는 질문은 붙여넣은 자료를 구분 표지와 함께 포함하고, 제목과 검색에는 질문 문장을 씁니다.
      const template = templateById(thread.template);
      const registeredId = registeredTemplateId(thread.template);
      const selected = registeredId
        ? await templatesGateway.read({ ...session, templateId: registeredId })
        : null;
      if (selected && !selected.ok) throw new Error(selected.error.message);
      const snapshot = selected?.ok ? freezeTemplate(selected.data) : null;
      const content = composeQuestion(
        question,
        attachments,
        template,
        false,
        thread.webEnabled,
        snapshot,
      );
      if (content.length > 65536)
        throw new Error(
          '템플릿과 첨부를 합친 내용이 질문 한도를 넘습니다. 지침이나 첨부를 줄여 주세요.',
        );
      const questionTurnId = chatId();
      // 전송 전 시작한 읽기가 이후의 낙관적 질문이나 실제 저장 결과를 덮지 못하게 합니다.
      readSerial.current += 1;
      setSubmitted({ id: questionTurnId, content, threadId: thread.id });
      setFoundCount(null);
      setPhase('관련 문서와 연결된 근거를 찾고 있어요');
      if (thread.webEnabled) setPhase('외부 웹 자료와 출처를 확인하고 있어요');
      // 토글이 켜진 질문 문장만 조사하며 첨부·위키·이전 대화는 외부 입력에 포함하지 않습니다.
      const web = thread.webEnabled
        ? (await chatRunsApi.webSearch({ ...session, question })).web
        : null;
      setPhase('관련 문서와 연결된 근거를 찾고 있어요');
      // 별도 AI 검색어 확장 없이 서버의 질문 색인이 관련 문서와 예외를 함께 찾는다.
      patchThread({
        noEvidenceQuestion: null,
        searchNotice: '관련 문서와 검토 근거를 준비하고 있어요.',
      });
      const context: Extract<
        WorkspaceRequest,
        { operation: 'questionContext' }
      >['input'] = {
        mode: 'on_demand',
        retrieval_scope: 'workspace',
        lookup_question: question,
        documents: thread.documents,
        required_documents: thread.documents,
        allow_empty: true,
        ...(web ? { web } : {}),
      };
      const basis = await requestChat({
        ...session,
        operation: 'questionContext',
        input: context,
      });
      if (
        basis.can_prepare !== true ||
        basis.complete !== true ||
        basis.truncated !== false ||
        !Array.isArray(basis.skipped) ||
        basis.skipped.length !== 0
      )
        throw new Error(
          '관련 문서의 근거를 모두 준비하지 못했습니다. 질문을 보존했습니다. 범위를 좁혀 다시 질문해 주세요.',
        );
      const preparedCount = Array.isArray(basis.documents)
        ? basis.documents.length
        : 0;
      const retrieval = basis.retrieval;
      const partialRetrieval =
        retrieval != null &&
        typeof retrieval === 'object' &&
        !Array.isArray(retrieval) &&
        retrieval.complete !== true;
      setFoundCount(preparedCount);
      patchThread({
        searchNotice: `${partialRetrieval ? '검색 범위 일부만 확인했습니다. ' : ''}허용된 공간에서 관련 문서 ${preparedCount}개와 검토 근거를 준비했습니다.${web ? ` ${webBasisSummary({ web }) ?? ''}` : ''}`,
      });
      let current: ChatEnvelope;
      if (thread.conversationId)
        current = await readConversation(thread.conversationId);
      else {
        const requestId = chatId();
        current = await write(
          {
            ...session,
            operation: 'createConversation',
            input: { request_id: requestId, title: question.slice(0, 200) },
          },
          {
            step: 'conversation',
            requestId,
            recordId: null,
            threadId: thread.id,
          },
        );
        patchThread({
          conversationId: current.record.id,
          title: question.slice(0, 60),
        });
        if (alive.current) acceptConversation(current);
        await preservePending(null);
      }
      if (thread.draftRevision && thread.draftRevision !== current.revision) {
        acceptConversation(current);
        throw new Error(
          '질문 작성 중 대화가 변경되었습니다. 갱신된 대화를 확인한 뒤 질문을 다시 보내 주세요.',
        );
      }
      current = await write(
        {
          ...session,
          operation: 'appendTurn',
          input: {
            record_id: current.record.id,
            request_id: questionTurnId,
            expected_revision: thread.draftRevision ?? current.revision,
            role: 'user',
            content,
            status: 'complete',
            context_request: context,
            ...(snapshot
              ? {
                  template_ref: {
                    id: snapshot.template.id,
                    revision: snapshot.template.revision,
                  },
                }
              : {}),
          },
        },
        {
          step: 'question',
          sentQuestion: content,
          requestId: questionTurnId,
          recordId: current.record.id,
          threadId: thread.id,
        },
      );
      patchThread({
        draft: '',
        attachments: [],
        template: registeredId ? thread.template : '',
        draftRevision: null,
        questionTurnId,
        runId: null,
      });
      if (alive.current) {
        acceptConversation(current);
        acceptRun(null);
        setSubmitted(null);
      }
      await preservePending(null);
      await createRun(current, questionTurnId);
    });
  }
  /** 재조회는 서버 기록만 읽으며 작성 중인 다음 질문은 바꾸지 않습니다. */
  async function refresh(): Promise<void> {
    const serial = ++readSerial.current;
    const current = stateRef.current.threads.find(
      (item: ChatThread): boolean => item.id === stateRef.current.activeId,
    );
    if (!current || invalidScope) return;
    try {
      const detail = current.runId
        ? await runChat((): ReturnType<typeof chatRunsApi.read> =>
            chatRunsApi.read({
              ...session,
              questionRunId: current.runId ?? '',
            }),
          )
        : null;
      const saved = current.conversationId
        ? await readConversation(current.conversationId)
        : null;
      if (
        !alive.current ||
        serial !== readSerial.current ||
        current.id !== stateRef.current.activeId
      )
        return;
      const latest = stateRef.current.threads.find(
        (item: ChatThread): boolean => item.id === current.id,
      );
      if (
        latest &&
        canAdvanceChatDraft(
          conversationRef.current,
          saved,
          detail,
          latest.draftRevision,
        )
      )
        patchThread({ draftRevision: saved?.revision ?? null });
      acceptRun(detail);
      if (detail && current.startUnconfirmed)
        patchThread({ startUnconfirmed: false });
      acceptConversation(saved);
      setError('');
    } catch (reason: unknown) {
      if (serial === readSerial.current) fail(reason);
    }
  }
  /** 저장 불명 요청은 동일 ID의 수신 기록만 조회하고 자동으로 AI를 시작하지 않습니다. */
  async function confirm(): Promise<void> {
    await perform(async (): Promise<void> => {
      const pending = stateRef.current.pending;
      if (!pending) return;
      if (pending.step === 'run') {
        const detail = await runChat(
          (): ReturnType<typeof chatRunsApi.creationReceipt> =>
            chatRunsApi.creationReceipt({
              ...session,
              requestId: pending.requestId,
            }),
        );
        patchThread({ runId: detail.id });
        acceptRun(detail);
        await preservePending(null);
        return;
      }
      const value = await requestChat({
        ...session,
        operation: 'personalReceipt',
        input: {
          kind: pending.step === 'artifact' ? 'saved-results' : 'conversations',
          request_id: pending.requestId,
          ...(pending.recordId ? { record_id: pending.recordId } : {}),
        },
      });
      if (
        value.request_confirmed !== true ||
        value.request_id !== pending.requestId
      )
        throw new Error('동일 요청의 저장 결과를 아직 확인하지 못했습니다.');
      const saved = record(
        value,
        pending.step === 'artifact' ? 'saved-results' : 'conversations',
        pending.requestId,
      );
      if (pending.step === 'artifact') {
        await preservePending(null);
        onArtifact(saved.record.id);
        return;
      }
      patchThread({
        conversationId: saved.record.id,
        ...(pending.step === 'question'
          ? {
              questionTurnId: pending.requestId,
              ...(chatTurns(saved).some(
                (turn: ChatTurn): boolean =>
                  turn.id === pending.requestId && !!turn.clarification_turn_id,
              ) && pending.sentQuestion === thread.draft
                ? { draft: '', draftRevision: null }
                : (registeredTemplateId(thread.template) &&
                      pending.sentQuestion &&
                      splitQuestion(pending.sentQuestion).question ===
                        thread.draft.trim() &&
                      JSON.stringify(
                        splitQuestion(pending.sentQuestion).attachments,
                      ) === JSON.stringify(thread.attachments)) ||
                    [false, true].some(
                      (noEvidence: boolean): boolean =>
                        composeQuestion(
                          thread.draft.trim(),
                          thread.attachments,
                          templateById(thread.template),
                          noEvidence,
                          thread.webEnabled,
                        ) === pending.sentQuestion,
                    )
                  ? {
                      draft: '',
                      attachments: [],
                      template: '',
                      draftRevision: null,
                    }
                  : {}),
              runId: null,
            }
          : {}),
      });
      acceptConversation(saved);
      if (pending.step === 'question') setSubmitted(null);
      await preservePending(null);
    });
  }
  /** 사용자가 재시도할 때 상태를 먼저 읽고 저장 답변/미확인 영수증을 우회하지 않습니다. */
  async function retry(): Promise<void> {
    await perform(async (): Promise<void> => {
      if (stateRef.current.pending)
        throw new Error('같은 요청 확인으로 저장 여부를 먼저 확인해 주세요.');
      if (!thread.conversationId || !thread.questionTurnId)
        throw new Error('질문을 입력창에서 다시 보내 주세요.');
      const current = await readConversation(thread.conversationId);
      const detail = thread.runId
        ? await runChat((): ReturnType<typeof chatRunsApi.read> =>
            chatRunsApi.read({ ...session, questionRunId: thread.runId ?? '' }),
          )
        : null;
      acceptConversation(current);
      acceptRun(detail);
      if (
        detail &&
        (chatRunActive(detail) ||
          chatRunUncertain(detail) ||
          detail.answers.length > 0 ||
          detail.receipts.some(
            (receipt: QuestionDetail['receipts'][number]): boolean =>
              receipt.saved === true,
          ))
      )
        throw new Error(
          '진행 중이거나 저장된 답변이 있습니다. 새 실행을 만들지 않았습니다.',
        );
      if (detail && chatRunStartable(detail)) {
        await startRun(detail);
      } else if (
        !detail ||
        ((detail.status === 'failed' || detail.status === 'cancelled') &&
          detail.receipts.length === 0 &&
          detail.local.requestId === null)
      )
        await createRun(current, thread.questionTurnId);
      else
        throw new Error(
          '답변 저장 결과를 먼저 확인해 주세요. 현재 실행은 재시작할 수 없습니다.',
        );
    });
  }
  /** 실행 중단은 현재 상태 판본과 명시 사용자 동작에 연결합니다. */
  async function cancel(): Promise<void> {
    await perform(async (): Promise<void> => {
      if (!run) return;
      // 취소 전 시작한 폴링이 늦게 도착해 실행 중 상태를 되살리지 않게 합니다.
      readSerial.current += 1;
      const detail = await runChat((): ReturnType<typeof chatRunsApi.cancel> =>
        chatRunsApi.cancel({
          ...session,
          questionRunId: run.id,
          expectedStateRevision: run.stateRevision,
          requestId: chatId(),
        }),
      );
      // 취소 응답을 기다리는 동안 시작된 읽기도 확정된 취소 응답보다 앞선 조회입니다.
      readSerial.current += 1;
      acceptRun(detail);
    });
  }
  /** 진단은 모델 호출 없이 현재 적용된 개인 CLI의 준비 상태를 확인합니다. */
  async function diagnose(): Promise<void> {
    await perform(async (): Promise<void> => {
      setPhase('개인 CLI 연결을 확인하고 있습니다');
      await readChatRuntime(true);
    });
  }
  /** 새 대화로 이동해도 이전 질문 초안과 저장 기록의 참조를 남깁니다. */
  function newChat(document?: string): ChatThread | null {
    if (locked.current || stateRef.current.pending) return null;
    if (document !== undefined && !isDocumentPath(document)) {
      setError('질문에 사용할 문서 참조가 올바르지 않습니다.');
      return null;
    }
    if (stateRef.current.threads.length >= 100) {
      setError('보존된 대화 100개에 도달했습니다. 기존 대화를 사용해 주세요.');
      return null;
    }
    const next = { ...emptyChat(), documents: document ? [document] : [] };
    update({
      ...stateRef.current,
      activeId: next.id,
      threads: [...stateRef.current.threads, next],
    });
    acceptConversation(null);
    acceptRun(null);
    setSubmitted(null);
    setError('');
    return next;
  }
  /** 이력 선택은 해당 범위의 기록만 읽으며 기존 초안을 삭제하지 않습니다. */
  function selectChat(id: string): ChatThread | null {
    const target = stateRef.current.threads.find(
      (item: ChatThread): boolean => item.id === id,
    );
    if (target && stateRef.current.activeId === id) return target;
    if (locked.current || stateRef.current.pending || !target) return null;
    update({ ...stateRef.current, activeId: id });
    acceptConversation(null);
    acceptRun(null);
    setSubmitted(null);
    setError('');
    return target;
  }
  /** 주소로 지정한 저장 대화를 읽되 다른 대화의 초안이나 진행 중 요청을 교체하지 않습니다. */
  async function openConversation(
    id: string,
    questionRunId?: string,
  ): Promise<ChatThread | null> {
    if (
      !/^[a-f0-9]{32}$/.test(id) ||
      (questionRunId && !/^[a-f0-9]{32}$/.test(questionRunId))
    ) {
      setError('대화 참조 형식이 올바르지 않습니다.');
      return null;
    }
    const previous = stateRef.current.threads.find(
      (item: ChatThread): boolean => item.conversationId === id,
    );
    if (previous && (!questionRunId || previous.runId === questionRunId))
      return selectChat(previous.id);
    if (locked.current || stateRef.current.pending) return null;
    let restored: ChatThread | null = null;
    await perform(async (): Promise<void> => {
      if (!previous && stateRef.current.threads.length >= 100)
        throw new Error(
          '보존된 대화 100개에 도달했습니다. 기존 대화를 사용해 주세요.',
        );
      const [current, detail] = await Promise.all([
        readConversation(id),
        questionRunId
          ? runChat((): ReturnType<typeof chatRunsApi.read> =>
              chatRunsApi.read({ ...session, questionRunId }),
            )
          : null,
      ]);
      if (detail && detail.conversationId !== id)
        throw new Error(
          '요청한 실행과 대화가 일치하지 않습니다. 다른 대화의 실행으로 바꾸지 않았습니다.',
        );
      if (!alive.current) return;
      restored = {
        ...(previous ?? emptyChat()),
        conversationId: id,
        ...(detail
          ? { runId: detail.id, questionTurnId: detail.questionTurnId }
          : {}),
        title:
          typeof current.record.data.title === 'string'
            ? current.record.data.title
            : '저장된 대화',
      };
      update({
        ...stateRef.current,
        activeId: restored.id,
        threads: previous
          ? stateRef.current.threads.map((item: ChatThread): ChatThread =>
              item.id === restored?.id ? restored : item,
            )
          : [...stateRef.current.threads, restored],
      });
      acceptConversation(current);
      acceptRun(detail);
      setSubmitted(null);
    });
    return restored;
  }
  useEffect((): (() => void) => {
    alive.current = true;
    let valid = true;
    void recovery
      .load()
      .then(async (saved: ChatRecovery | null): Promise<void> => {
        if (!valid || !alive.current) return;
        if (saved) {
          if (
            !saved.threads.some(
              (item: ChatThread): boolean => item.id === saved.activeId,
            )
          )
            throw new Error('복원할 대화 참조를 확인할 수 없습니다.');
          update(saved);
        }
        setRecoveryNotice('');
        setReady(true);
      })
      .catch((reason: unknown): void => {
        if (valid && alive.current)
          setRecoveryNotice(
            reason instanceof Error ? reason.message : '보호 복구 조회 실패',
          );
      });
    void readChatRuntime().catch((reason: unknown): void => {
      if (valid && alive.current) fail(reason);
    });
    return (): void => {
      valid = false;
      alive.current = false;
      readSerial.current += 1;
    };
  }, [recovery, recoveryAttempt]);
  useEffect((): void => {
    if (!ready) return;
    // 화면 이동 직전 입력도 보호 저장 큐에 넣고 지연 타이머로 버리지 않습니다.
    void recovery.save(stateRef.current).catch((reason: unknown): void => {
      if (alive.current)
        setRecoveryNotice(
          reason instanceof Error ? reason.message : '초안 복구 저장 실패',
        );
    });
  }, [state, ready, recovery]);
  // 결과물은 "내려받기"를 누를 때만 만듭니다. 대화 기록(답변 본문·근거)은 서버에 항상 저장되므로 답변마다 복사본을 쌓지 않습니다.
  const refreshFromEffect = useEffectEvent(refresh);
  useEffect((): (() => void) | undefined => {
    if (!ready) return;
    let active = true;
    const id = state.activeId;
    void refreshFromEffect().finally((): void => {
      if (active) setLoadedThread(id);
    });
    return (): void => {
      active = false;
      readSerial.current += 1;
    };
  }, [state.activeId, ready]);
  const activeRunId = run?.id;
  const activeRun = chatRunActive(run);
  useEffect((): (() => void) | undefined => {
    if (!activeRunId || busy || invalidScope || !activeRun) return;
    let reading = false;
    // 본문 갱신으로 타이머를 다시 만들지 않아 저장 영수증 조회가 밀리지 않습니다.
    const timer = setInterval((): void => {
      if (reading) return;
      reading = true;
      void refreshFromEffect().finally((): void => {
        reading = false;
      });
    }, 1500);
    return (): void => clearInterval(timer);
  }, [activeRunId, activeRun, busy, invalidScope]);

  useEffect((): (() => void) | undefined => {
    if (!activeRunId || busy || invalidScope || !activeRun) return;
    const runId = activeRunId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const threadId = state.activeId;
    /** 서버 재조회와 별도로 현재 프로세스의 생성 중 본문만 빠르게 받습니다. */
    async function readLocal(): Promise<void> {
      const serial = readSerial.current;
      try {
        const result = await chatRunsApi.readLocal({
          ...session,
          questionRunId: runId,
        });
        if (
          disposed ||
          !alive.current ||
          locked.current ||
          serial !== readSerial.current ||
          stateRef.current.activeId !== threadId ||
          !result.ok ||
          !result.data ||
          result.data.runId !== activeRunId
        )
          return;
        const data = result.data;
        setRun((current: QuestionDetail | null): QuestionDetail | null =>
          mergeChatRunLocal(current, data.runId, data.local),
        );
      } catch {
        // 로컬 전달 실패는 서버의 정상 답변 확인·기존 오류 경로를 바꾸지 않습니다.
      } finally {
        if (!disposed)
          timer = setTimeout((): void => {
            void readLocal();
          }, 250);
      }
    }
    timer = setTimeout((): void => {
      void readLocal();
    }, 250);
    return (): void => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [activeRunId, activeRun, busy, invalidScope, session, state.activeId]);

  const resumable = useSessionAvailability(
    conversation?.record.id,
    runtime?.activeProvider,
    conversation?.record.events.length ?? 0,
    ready && !busy && !loading && !chatRunActive(run) && !invalidScope,
  );
  // 파일 선택이나 변환 도중 다른 대화를 열면 이전 결과를 새 대화에 넣지 않는다.
  function currentAttachments(): ChatAttachment[] | undefined {
    const latest = stateRef.current;
    if (
      !alive.current ||
      locked.current ||
      latest.activeId !== state.activeId ||
      chatAwaitingClarification(conversationRef.current)
    )
      return;
    return latest.threads.find(
      (item: ChatThread): boolean => item.id === latest.activeId,
    )?.attachments;
  }

  return {
    resumable,
    thread,
    threads: state.threads,
    conversation,
    run,
    clarification: invalidScope
      ? null
      : chatAwaitingClarification(conversation),
    submittedQuestion: invalidScope
      ? null
      : visibleSubmittedQuestion(
          submitted,
          state.pending,
          thread.id,
          chatTurns(conversation),
        ),
    busy,
    loading,
    ready,
    invalidScope,
    phase,
    foundCount,
    error,
    recoveryNotice,
    runtime,
    pending: state.pending,
    ensureAnswerArtifact,
    setTemplate: (value: string): void => {
      if (!chatAwaitingClarification(conversationRef.current))
        patchThread({ template: value });
    },
    setWebEnabled: (value: boolean): void => {
      if (!chatAwaitingClarification(conversationRef.current))
        patchThread({ webEnabled: value });
    },
    setWebQuery: (value: string): void => {
      if (!chatAwaitingClarification(conversationRef.current))
        patchThread({ webQuery: value });
    },
    attachmentRoom: (): number => {
      const items = currentAttachments();
      return items ? remainingCapacity(items) : 0;
    },
    addAttachment: (
      draft: Parameters<KnowledgeChatModel['addAttachment']>[0],
    ): 'added' | 'truncated' | 'full' => {
      const items = currentAttachments();
      if (!items) return 'full';
      const fitted = fitAttachment(items, {
        id: chatId(),
        kind: draft.kind,
        name: draft.name ?? nextPastedName(items),
        text: draft.text,
        ...(draft.truncated ? { truncated: true } : {}),
      });
      if (!fitted) return 'full';
      patchThread({ attachments: [...items, fitted] });
      return fitted.truncated ? 'truncated' : 'added';
    },
    removeAttachment: (id: string): void => {
      if (!chatAwaitingClarification(conversationRef.current))
        patchThread({
          attachments: thread.attachments.filter(
            (item: ChatAttachment): boolean => item.id !== id,
          ),
        });
    },
    setDraft: (value: string): void =>
      patchThread({
        draft: value,
        draftRevision: thread.draftRevision ?? conversation?.revision ?? null,
      }),
    acknowledgeConversation: (): void => {
      if (conversation && !locked.current) {
        patchThread({ draftRevision: conversation.revision });
        setError('');
      }
    },
    /** 입력창에서 고른 모델을 바로 저장해 다음 질문부터 씁니다. 실패하면 이전 선택을 유지하고 알립니다. */
    selectModel: async (value: string): Promise<void> => {
      if (!runtime || busy || chatRunActive(run)) return;
      try {
        await selectChatModel(runtime.activeProvider, value);
      } catch (cause: unknown) {
        setError(
          cause instanceof Error ? cause.message : '모델을 바꾸지 못했습니다.',
        );
      }
    },
    retryRecovery: (): void => {
      if (!ready) setRecoveryAttempt(recoveryAttempt + 1);
    },
    send,
    retry,
    refresh,
    confirm,
    cancel,
    newChat,
    selectChat,
    openConversation,
    clearDocumentScope: (): void => {
      if (
        !locked.current &&
        !stateRef.current.pending &&
        !chatRunActive(run) &&
        !chatAwaitingClarification(conversationRef.current)
      )
        patchThread({
          documents: [],
          noEvidenceQuestion: null,
          searchNotice: '',
        });
    },
    diagnose,
  };
}
