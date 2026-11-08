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
import { templateById } from './answerTemplates';
import {
  ChatRequestError,
  chatRunsApi,
  readChatRuntime,
  selectChatModel,
  requestChat,
  runChat,
  saveAnswerArtifact,
} from '../api/knowledgeChat.api';
import type { AnswerArtifact, ChatAccess } from '../api/knowledgeChat.api';
import {
  chatEnvelopeSchema,
  chatId,
  chatQuestionSchema,
  chatWebQuerySchema,
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

export type KnowledgeChatModel = {
  thread: ChatThread;
  threads: ChatThread[];
  conversation: ChatEnvelope | null;
  run: QuestionDetail | null;
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
  const [run, setRun] = useState<QuestionDetail | null>(null);
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
  // 답변 턴 ID별 내 폴더 저장 결과와 진행 중 요청입니다. 같은 답변은 한 번만 저장합니다.
  const savedAnswers = useRef(new Map<string, AnswerArtifact>());
  const savingAnswers = useRef(
    new Map<string, Promise<AnswerArtifact | null>>(),
  );
  const selected = state.threads.find(
    (item: ChatThread): boolean => item.id === state.activeId,
  );
  const thread = selected ?? state.threads[0];
  if (!thread) throw new Error('대화 복구 항목이 없습니다.');

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
      setConversation(null);
      setRun(null);
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
          }),
        );
      },
    );
    patchThread({ runId: detail.id });
    if (alive.current) setRun(detail);
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
    if (alive.current) setRun(started);
    patchThread({ startUnconfirmed: false });
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
      const attachments = thread.attachments;
      // 웹 조사에는 별도 입력한 검색어만 보냅니다. 질문·문서·첨부·이전 대화는 포함하지 않습니다.
      const webQuery = thread.webEnabled
        ? chatWebQuerySchema.parse(thread.webQuery)
        : null;
      // 저장·전송하는 질문은 붙여넣은 자료를 구분 표지와 함께 포함하고, 제목과 검색에는 질문 문장을 씁니다.
      const template = templateById(thread.template);
      setFoundCount(null);
      setPhase('관련 문서와 연결된 근거를 찾고 있어요');
      if (webQuery) setPhase('외부 웹 자료와 출처를 확인하고 있어요');
      const web = webQuery
        ? (await chatRunsApi.webSearch({ ...session, query: webQuery })).web
        : null;
      // 별도 AI 검색어 확장 없이 서버의 질문 색인이 관련 문서와 예외를 함께 찾는다.
      const content = composeQuestion(
        question,
        attachments,
        template,
        false,
        thread.webEnabled,
      );
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
        if (alive.current) setConversation(current);
        await preservePending(null);
      }
      if (thread.draftRevision && thread.draftRevision !== current.revision) {
        setConversation(current);
        throw new Error(
          '질문 작성 중 대화가 변경되었습니다. 갱신된 대화를 확인한 뒤 질문을 다시 보내 주세요.',
        );
      }
      const questionTurnId = chatId();
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
        template: '',
        webEnabled: false,
        webQuery: '',
        draftRevision: null,
        questionTurnId,
        runId: null,
      });
      if (alive.current) {
        setConversation(current);
        setRun(null);
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
      setRun(detail);
      if (detail && current.startUnconfirmed)
        patchThread({ startUnconfirmed: false });
      setConversation(saved);
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
        setRun(detail);
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
              ...([false, true].some(
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
                    webEnabled: false,
                    webQuery: '',
                    draftRevision: null,
                  }
                : {}),
              runId: null,
            }
          : {}),
      });
      setConversation(saved);
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
      setConversation(current);
      setRun(detail);
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
      if (run)
        setRun(
          await runChat((): ReturnType<typeof chatRunsApi.cancel> =>
            chatRunsApi.cancel({
              ...session,
              questionRunId: run.id,
              expectedStateRevision: run.stateRevision,
              requestId: chatId(),
            }),
          ),
        );
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
    setConversation(null);
    setRun(null);
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
    setConversation(null);
    setRun(null);
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
      setConversation(current);
      setRun(detail);
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
  /**
   * 답변을 내 폴더의 결과물로 저장하고 결과를 돌려줍니다. 권한이 없거나 실패하면 null이며
   * 오류는 던지지 않아 답변 표시와 내려받기를 막지 않습니다. 저장 확인이 필요한지는 호출자가 null로 구별합니다.
   */
  function ensureAnswerArtifact(
    turn: ChatTurn,
  ): Promise<AnswerArtifact | null> {
    const done = savedAnswers.current.get(turn.id);
    if (done) return Promise.resolve(done);
    const running = savingAnswers.current.get(turn.id);
    if (running) return running;
    const conversationId = conversation?.record.id;
    if (
      !conversationId ||
      turn.role !== 'assistant' ||
      turn.status === 'failed' ||
      !turn.content.trim() ||
      !access.permissions.includes('result_write')
    )
      return Promise.resolve(null);
    const number =
      chatTurns(conversation)
        .filter((item: ChatTurn): boolean => item.role === 'assistant')
        .findIndex((item: ChatTurn): boolean => item.id === turn.id) + 1;
    const title = `${thread.title}${number > 1 ? ` (${number})` : ''}`;
    const request = saveAnswerArtifact(session, {
      conversationId,
      turnId: turn.id,
      title,
    })
      .then((saved: AnswerArtifact): AnswerArtifact => {
        savedAnswers.current.set(turn.id, saved);
        return saved;
      })
      .catch((): null => null)
      .finally((): void => {
        savingAnswers.current.delete(turn.id);
      });
    savingAnswers.current.set(turn.id, request);
    return request;
  }
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
  useEffect((): (() => void) | undefined => {
    if (!run || busy || invalidScope || !chatRunActive(run)) return;
    const timer = setTimeout((): void => {
      void refreshFromEffect();
    }, 1500);
    return (): void => clearTimeout(timer);
  }, [run, busy, invalidScope]);

  const resumable = useSessionAvailability(
    conversation?.record.id,
    runtime?.activeProvider,
    conversation?.record.events.length ?? 0,
    ready && !busy && !loading && !chatRunActive(run) && !invalidScope,
  );
  // 파일 선택이나 변환 도중 다른 대화를 열면 이전 결과를 새 대화에 넣지 않는다.
  function currentAttachments(): ChatAttachment[] | undefined {
    const latest = stateRef.current;
    if (!alive.current || locked.current || latest.activeId !== state.activeId)
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
    setTemplate: (value: string): void => patchThread({ template: value }),
    setWebEnabled: (value: boolean): void => patchThread({ webEnabled: value }),
    setWebQuery: (value: string): void => patchThread({ webQuery: value }),
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
    removeAttachment: (id: string): void =>
      patchThread({
        attachments: thread.attachments.filter(
          (item: ChatAttachment): boolean => item.id !== id,
        ),
      }),
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
      if (!locked.current && !stateRef.current.pending && !chatRunActive(run))
        patchThread({
          documents: [],
          noEvidenceQuestion: null,
          searchNotice: '',
        });
    },
    diagnose,
  };
}
