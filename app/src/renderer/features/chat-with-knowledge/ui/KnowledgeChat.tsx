import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import type { ExportFormat } from '@contracts/fileExports.contract';
import { ConnectionNotice, EmptyState } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { aiModelOptions } from '../model/aiModelOptions';
import {
  downloadAnswerMarkdown,
  loadChatAccess,
} from '../api/knowledgeChat.api';
import type { ChatAccess } from '../api/knowledgeChat.api';
import { useKnowledgeChat } from '../model/useKnowledgeChat';
import { answerFileTitle } from '../model/fileSummary';
import { buildChatTranscript } from '../model/chatTranscript';
import type { ChatMessage } from '../model/chatTranscript';
import { useChatNavigation } from '../model/useChatNavigation';
import { attachChatFiles } from '../api/attachChatFiles';
import {
  supportsAttachmentDrop,
  supportsFileAttachment,
} from '@renderer/platform/attachments';
import { templateById } from '../model/answerTemplates';
import { splitOutputDirective } from '../model/outputIntent';
import {
  chatRunActive,
  chatRunUncertain,
  chatTurns,
  chatWebQuerySchema,
} from '../model/chatState';
import type { ChatThread, ChatTurn } from '../model/chatState';
import { chatLocationForThread } from '../model/chatNavigation';
import type { ChatLocation } from '../model/chatNavigation';
import { ChatRunFeedback, chatProblem } from './ChatRunFeedback';
import { getAiConnectionPresentation } from '@renderer/shared/lib/useAiConnection';
import { sessionContinuationHint } from '../model/sessionContinuation';
import { ChatComposer } from './ChatComposer';
import { ChatReply } from './ChatReply';
import { ChatQuestionMessage } from './ChatQuestionMessage';
import { useChatPanes } from './useChatPanes';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { ChatEvidencePanel } from './ChatEvidencePanel';
import { SkeletonBar } from '@renderer/shared/ui/Skeleton';
import { ChatSkeleton } from './ChatSkeleton';
import composerStyles from './ChatComposer.module.scss';
import styles from './KnowledgeChat.module.scss';

export type KnowledgeChatProps = {
  onArtifact: (id: string) => void;
  location: ChatLocation;
  onNavigate: (location: ChatLocation, replace?: boolean) => void;
};
type ConnectedKnowledgeChatProps = KnowledgeChatProps & { access: ChatAccess };
/** 빈 화면에서 눌러 입력창에 채우는 예시 질문입니다. 보내지는 않습니다. */
const EXAMPLE_QUESTIONS: readonly string[] = [
  '최근에 바뀐 문서가 뭐야?',
  '두 문서를 비교해 줘',
  '이 위키에 어떤 내용이 있어?',
];

export function KnowledgeChat({
  onArtifact,
  location,
  onNavigate,
}: KnowledgeChatProps): JSX.Element {
  const [access, setAccess] = useState<ChatAccess | null>(null);
  const [error, setError] = useState('');
  useEffect((): (() => void) => {
    let active = true;
    let serial = 0;
    /** 창으로 돌아오면 현재 인증 범위를 다시 확인합니다. */
    async function check(): Promise<void> {
      const request = ++serial;
      try {
        const next = await loadChatAccess();
        if (!active || request !== serial) return;
        setAccess((previous: ChatAccess | null): ChatAccess =>
          JSON.stringify(previous) === JSON.stringify(next)
            ? (previous ?? next)
            : next,
        );
        setError('');
      } catch (reason: unknown) {
        if (active && request === serial) {
          setAccess(null);
          setError(
            reason instanceof Error
              ? reason.message
              : '연결을 확인하지 못했습니다.',
          );
        }
      }
    }
    void check();
    window.addEventListener('focus', check);
    window.addEventListener('wiki-connection-changed', check);
    return (): void => {
      active = false;
      window.removeEventListener('focus', check);
      window.removeEventListener('wiki-connection-changed', check);
    };
  }, []);
  if (error)
    return (
      <EmptyState
        title="작업 공간을 연결해 주세요"
        description={error}
        action={
          <Link className={styles.button} to="/settings">
            연결하기
          </Link>
        }
      />
    );
  if (!access)
    return (
      <p className={styles.connectionEmpty} role="status">
        현재 작업 공간을 확인하고 있습니다.
      </p>
    );
  return (
    <ConnectedKnowledgeChat
      key={JSON.stringify(access.session)}
      access={access}
      onArtifact={onArtifact}
      location={location}
      onNavigate={onNavigate}
    />
  );
}

/** 파일 이름으로 쓸 제목에서 제어 문자를 빼고 비면 기본값을 씁니다. */
function downloadTitle(title: string): string {
  const cleaned = Array.from(title)
    .filter((character: string): boolean => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== '새 대화' ? cleaned : 'AI 답변';
}
/** 대화·목록·근거를 같은 화면에서 탐색하며 대상 선택과 복귀 위치를 주소로 유지합니다. */
function ConnectedKnowledgeChat({
  access,
  onArtifact,
  location,
  onNavigate,
}: ConnectedKnowledgeChatProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const activity = useRef(active);
  useLayoutEffect((): void => {
    activity.current = active;
  }, [active]);
  /** 이전 실행의 산출물 저장 확인이 끝나도 다른 화면을 보고 있으면 이동하지 않습니다. */
  function artifactSaved(id: string): void {
    if (activity.current) onArtifact(id);
  }
  const model = useKnowledgeChat(access, artifactSaved);
  const { navigationError, locationMatches } = useChatNavigation({
    model,
    location,
    active,
    activity,
    onNavigate,
  });
  const scrollPositions = useRef(
    new Map<string, { top: number; follow: boolean }>(),
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const followAnswer = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const running = chatRunActive(model.run);
  // 아직 저장되지 않은 생성 중 답변입니다. 저장된 답변이 생기면 비워 두 번 보이지 않게 합니다.
  const livePreview =
    model.run?.local.preview &&
    model.run.answers.length === 0 &&
    !model.run.receipts.some(
      (receipt: NonNullable<typeof model.run>['receipts'][number]): boolean =>
        receipt.saved === true,
    )
      ? splitOutputDirective(model.run.local.preview).body
      : '';
  const uncertainRun = model.run !== null && chatRunUncertain(model.run);
  const uncertain = model.thread.startUnconfirmed || uncertainRun;
  const loading = model.loading || !model.ready;
  const disabled =
    model.busy || loading || model.invalidScope || !locationMatches;
  // 같은 동작은 본문·예시·모델·범위 제어에서 같은 잠금 판단을 재사용합니다.
  const actionsDisabled = disabled || running;
  const pending = model.pending !== null;
  const modelDisabled = actionsDisabled || pending;
  const scopeDisabled = modelDisabled || uncertain;
  // 연결 여부는 다른 화면과 같은 공통 훅으로 판단합니다. 진단 점검 항목은 실패 사유 안내에만 씁니다.
  const ai = useAiConnection();
  const aiUnavailable = ai.status === 'required';
  const canWrite = access.permissions.includes('conversation_write');
  const canSend =
    !scopeDisabled &&
    !!model.thread.draft.trim() &&
    (!model.thread.webEnabled ||
      chatWebQuerySchema.safeParse(model.thread.webQuery).success) &&
    !aiUnavailable &&
    canWrite;
  const turns = useMemo(
    (): ChatTurn[] => (model.invalidScope ? [] : chatTurns(model.conversation)),
    [model.invalidScope, model.conversation],
  );
  const transcript = useMemo(
    (): ChatMessage[] => buildChatTranscript(turns, model.run?.answers ?? []),
    [turns, model.run?.answers],
  );
  // 아직 보내지 않은 빈 대화는 목록에 쌓지 않습니다.
  const savedThreads = model.threads.filter(
    (item: ChatThread): boolean => !!item.conversationId || !!item.draft,
  );
  const selectedMessage = transcript.find(
    (item: ChatMessage): boolean => item.turn.id === location.answer,
  );
  const selectedTurn = selectedMessage?.turn;
  const selectedCitations = selectedMessage?.citations ?? [];
  const evidenceIndex =
    location.evidence === 'all' ? null : Number(location.evidence);
  const selectedCitation =
    evidenceIndex !== null &&
    Number.isInteger(evidenceIndex) &&
    evidenceIndex >= 0
      ? selectedCitations[evidenceIndex]
      : undefined;
  const evidence = location.answer
    ? {
        title:
          location.evidence === 'all'
            ? '답변에 사용한 근거'
            : selectedCitation
              ? `인용 ${Number(location.evidence) + 1}`
              : '근거를 찾을 수 없습니다',
        citations:
          location.evidence === 'all'
            ? selectedCitations
            : selectedCitation
              ? [selectedCitation]
              : [],
      }
    : null;
  const {
    workspace,
    historyPane,
    conversationPane,
    evidencePane,
    rememberEvidence,
    layout,
    historyVisible,
    conversationVisible,
    evidenceVisible,
    setHistoryOpen,
    closeEvidence,
    openEvidence,
    rememberFocus,
  } = useChatPanes(location, !!evidence, navigationError, onNavigate);
  useLayoutEffect((): void => {
    const panel = messages.current;
    const id = model.thread.id;
    const positions = scrollPositions.current;
    const saved = positions.get(id);
    followAnswer.current = saved?.follow ?? true;
    setAwayFromLatest(saved ? !saved.follow : false);
    if (panel && saved) panel.scrollTop = saved.top;
  }, [model.thread.id]);
  useLayoutEffect((): void => {
    const saved = scrollPositions.current.get(model.thread.id);
    if (!model.loading && saved && messages.current && !saved.follow)
      messages.current.scrollTop = saved.top;
  }, [model.loading, model.thread.id]);
  const provider =
    model.runtime?.activeProvider === 'claude'
      ? 'Claude Code'
      : model.runtime?.activeProvider === 'codex'
        ? 'Codex'
        : 'AI';
  const currentModel = model.runtime?.activeModel ?? 'default';
  const fixedOptions = model.runtime
    ? aiModelOptions[model.runtime.activeProvider]
    : [];
  const modelOptions = fixedOptions.some(
    (option: { value: string }): boolean => option.value === currentModel,
  )
    ? fixedOptions
    : [...fixedOptions, { value: currentModel, label: currentModel }];
  const failedRun =
    model.run?.status === 'failed' || model.run?.local.status === 'failed';
  const answerCount = model.run?.answers.length ?? 0;
  const working = running || (model.busy && Boolean(model.phase));
  const problem = chatProblem(model, uncertain, failedRun, aiUnavailable);
  const headerStatus = getAiConnectionPresentation(ai.level, provider);
  const idle = !working && !aiUnavailable && !problem;
  const failedHeader = failedRun && !aiUnavailable;
  const showStart =
    !disabled &&
    idle &&
    turns.length === 0 &&
    !model.thread.draft &&
    !model.thread.template &&
    model.thread.attachments.length === 0;
  const showRetry =
    !!model.thread.questionTurnId &&
    !running &&
    !uncertainRun &&
    answerCount === 0 &&
    model.run?.status !== 'complete';
  const lastTurn = turns.at(-1)?.id;
  useEffect((): void => {
    if (active && followAnswer.current)
      messages.current?.scrollTo({ top: messages.current.scrollHeight });
  }, [lastTurn, model.run?.local.preview, active]);

  /**
   * 내 폴더에 저장된 결과물을 원하는 위치에 Markdown 파일로 저장합니다.
   * 자동 저장이 되지 않았다면 한 번 더 시도하고, 그래도 안 되면 답변 본문을 그대로 내려받되 저장 확인이 필요함을 알립니다.
   */
  async function downloadAnswer(
    turn: ChatTurn,
    format: ExportFormat,
  ): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const saved = await model.ensureAnswerArtifact(turn);
      const canSave = access.permissions.includes('result_write');
      const answer = splitOutputDirective(saved?.content ?? turn.content);
      const result = await downloadAnswerMarkdown(
        access.session,
        answer.format
          ? answerFileTitle(answer.body, downloadTitle(model.thread.title))
          : downloadTitle(saved?.title ?? model.thread.title),
        answer.body,
        format,
      );
      if (!result.ok) setDownloadError(result.error.message);
      else if (!saved && canSave)
        setDownloadError(
          '파일은 저장했지만 내 폴더의 결과물 저장 확인이 필요합니다.',
        );
    } catch {
      setDownloadError('답변을 내려받지 못했습니다.');
    } finally {
      setDownloading(false);
    }
  }
  const latestMessage = transcript.at(-1);
  const latest = latestMessage?.turn;
  const latestSearch =
    latestMessage?.kind === 'answer' &&
    latestMessage.questionTurnId !== null &&
    latestMessage.questionTurnId === model.thread.questionTurnId
      ? model.thread.searchNotice
      : '';
  /** 후속 질문은 같은 대화의 새 실행이므로 이전 답변·실행을 고정한 주소 선택을 해제합니다. */
  function sendQuestion(): void {
    if (!canSend) return;
    if (location.questionRunId || location.answer || location.evidence)
      onNavigate(
        {
          ...chatLocationForThread(model.thread),
          questionRunId: undefined,
          panel: location.panel,
        },
        true,
      );
    void model.send();
  }
  /** IME 조합 중 Enter는 질문 제출로 해석하지 않습니다. */
  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !event.repeat
    ) {
      event.preventDefault();
      sendQuestion();
    }
  }
  /** 현재 대화의 근거 선택만 바꾸고 대화 입력이나 실행 상태는 건드리지 않습니다. */
  function selectEvidence(turn: ChatTurn, index?: number): void {
    rememberEvidence(`${turn.id}:${index === undefined ? 'all' : index}`);
    onNavigate({
      ...chatLocationForThread(model.thread),
      answer: turn.id,
      evidence: index === undefined ? 'all' : String(index),
    });
  }
  /** 명시 대화 선택은 허용된 전환일 때만 주소에 추가합니다. */
  function selectThread(id: string): void {
    const target = model.selectChat(id);
    if (target) onNavigate(chatLocationForThread(target));
  }
  if (model.invalidScope)
    return (
      <EmptyState
        title="현재 접근 권한을 확인해 주세요"
        description={model.error}
        detail="이전 작업 공간의 대화는 이 화면에서 숨겼습니다."
        action={
          <Link className={styles.button} to="/settings">
            연결하기
          </Link>
        }
      />
    );
  return (
    <section
      ref={workspace}
      className={styles.root}
      aria-label="AI 채팅"
      data-layout={layout}
      data-history={historyVisible}
      data-evidence={evidenceVisible}
    >
      <ChatHistoryPanel
        panelRef={historyPane}
        visible={historyVisible}
        narrow={layout === 'narrow'}
        disabled={disabled || !!model.pending}
        threads={savedThreads}
        selected={navigationError ? null : model.thread.id}
        onClose={(): void => setHistoryOpen(false)}
        onSelect={selectThread}
        onNew={(): void => {
          const target = model.newChat();
          if (target) {
            onNavigate(chatLocationForThread(target));
            textarea.current?.focus();
          }
        }}
      />
      <div
        ref={conversationPane}
        tabIndex={-1}
        hidden={!conversationVisible}
        className={styles.column}
        onFocusCapture={rememberFocus}
      >
        {navigationError ? (
          <section className={styles.connectionEmpty} role="alert">
            <h1>선택한 대화를 열 수 없습니다</h1>
            <p>{navigationError}</p>
            <button
              className={styles.button}
              type="button"
              onClick={(): void =>
                onNavigate(chatLocationForThread(model.thread))
              }
            >
              현재 대화로 돌아가기
            </button>
          </section>
        ) : !locationMatches ? (
          <>
            <div className={styles.header} aria-hidden="true">
              <SkeletonBar shape="title" />
            </div>
            <div className={styles.messages}>
              <ChatSkeleton />
            </div>
            <div className={composerStyles.composer} aria-hidden="true">
              <SkeletonBar shape="title" />
            </div>
          </>
        ) : (
          <>
            <header className={styles.header}>
              <div className={styles.titleGroup}>
                {!historyVisible && (
                  <button
                    className={`${styles.ghost} ${styles.iconButton}`}
                    type="button"
                    aria-label="대화 목록 열기"
                    title="대화 목록 열기"
                    aria-expanded={historyVisible}
                    aria-controls="chat-history"
                    onClick={(): void => setHistoryOpen(true)}
                  >
                    <Icon name="panel-left" />
                  </button>
                )}
                <h1 className={styles.title}>{model.thread.title}</h1>
              </div>
              <div className={styles.actions}>
                <span
                  className={`${styles.status} ${styles[failedHeader ? 'bad' : headerStatus.tone]}`}
                >
                  <i aria-hidden="true" />
                  {failedHeader ? '응답 오류' : headerStatus.word}
                </span>
                {evidence && !evidenceVisible && (
                  <button
                    className={`${styles.ghost} ${styles.iconButton}`}
                    type="button"
                    aria-label="선택한 답변 근거 열기"
                    title="선택한 답변 근거 열기"
                    aria-expanded={evidenceVisible}
                    aria-controls="chat-evidence"
                    onClick={(): void => {
                      openEvidence();
                    }}
                  >
                    <Icon name="panel-right" />
                  </button>
                )}
              </div>
            </header>
            <div
              className={styles.messages}
              ref={messages}
              onScroll={(): void => {
                const panel = messages.current;
                if (!panel || model.loading || !locationMatches) return;
                const near =
                  panel.scrollHeight - panel.scrollTop - panel.clientHeight <
                  64;
                followAnswer.current = near;
                setAwayFromLatest(!near);
                scrollPositions.current.set(model.thread.id, {
                  top: panel.scrollTop,
                  follow: near,
                });
              }}
              role="log"
              aria-label="질문과 답변"
              aria-live="polite"
              aria-relevant="additions"
            >
              {loading && <ChatSkeleton />}
              {showStart && (
                <div className={styles.empty}>
                  <h2>무엇을 찾아볼까요?</h2>
                  <p>위키에 저장된 문서에서 근거를 찾아 답합니다.</p>
                  <div className={styles.examples}>
                    {EXAMPLE_QUESTIONS.map((text: string): JSX.Element => (
                      <button
                        key={text}
                        type="button"
                        className={styles.example}
                        disabled={actionsDisabled}
                        onClick={(): void => {
                          model.setDraft(text);
                          textarea.current?.focus();
                        }}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {transcript.map((message: ChatMessage): JSX.Element => {
                const { turn, question } = message;
                if (message.kind === 'question')
                  return (
                    <ChatQuestionMessage
                      key={turn.id}
                      question={message.question}
                    />
                  );
                return (
                  <ChatReply
                    key={turn.id}
                    turn={turn}
                    citations={message.citations}
                    noWiki={question?.noEvidence ?? false}
                    partialSearch={
                      latest?.id === turn.id &&
                      latestSearch.startsWith('검색 범위 일부만')
                    }
                    title={downloadTitle(model.thread.title)}
                    suggested={
                      templateById(question?.template?.id ?? '')
                        ?.suggestedFormat
                    }
                    downloading={downloading}
                    disabled={actionsDisabled || !question?.question}
                    onAsk={(): void => {
                      model.setDraft(question?.question ?? '');
                      textarea.current?.focus();
                    }}
                    onEvidence={(index: number): void =>
                      selectEvidence(turn, index)
                    }
                    onDownload={(format: ExportFormat): void => {
                      void downloadAnswer(turn, format);
                    }}
                    onCopyError={(): void =>
                      setDownloadError('복사하지 못했습니다.')
                    }
                  />
                );
              })}
              <ChatRunFeedback
                model={model}
                working={working}
                running={running}
                preview={livePreview}
                problem={problem}
                disabled={disabled}
                provider={provider}
                showRetry={showRetry}
              />
            </div>
            {showRetry && idle && (
              <StatusNotice
                variant="box"
                tone="info"
                className={styles.footerNotice}
                action={
                  <button
                    className={styles.button}
                    type="button"
                    disabled={disabled}
                    onClick={(): void => {
                      void model.retry();
                    }}
                  >
                    답변 요청
                  </button>
                }
              >
                저장된 질문을 이어서 실행할 수 있어요.
              </StatusNotice>
            )}
            {model.thread.draft &&
              model.thread.draftRevision &&
              model.conversation &&
              model.thread.draftRevision !== model.conversation.revision && (
                <StatusNotice
                  variant="box"
                  tone="info"
                  className={styles.footerNotice}
                  action={
                    <button
                      className={styles.button}
                      type="button"
                      disabled={disabled}
                      onClick={model.acknowledgeConversation}
                    >
                      갱신된 대화 확인 · 질문 유지
                    </button>
                  }
                >
                  질문 작성 중 대화가 갱신되었어요. 위 대화를 먼저 확인해
                  주세요.
                </StatusNotice>
              )}
            {!model.ready && model.recoveryNotice && (
              <button
                className={styles.button}
                type="button"
                onClick={model.retryRecovery}
              >
                보관된 초안 다시 읽기
              </button>
            )}
            {awayFromLatest && (
              <button
                className={styles.button}
                onClick={(): void => {
                  followAnswer.current = true;
                  setAwayFromLatest(false);
                  messages.current?.scrollTo({
                    top: messages.current.scrollHeight,
                  });
                }}
              >
                최신 답변으로 이동 <Icon name="chevron-down" />
              </button>
            )}
            {aiUnavailable && !problem && (
              <ConnectionNotice
                kind={
                  ai.level === 'error' ? 'chat-ai-error' : 'chat-ai-required'
                }
                action={
                  <Link className={styles.button} to="/settings?section=ai">
                    AI 연결하기
                  </Link>
                }
              />
            )}
            <ChatComposer
              key={model.thread.id}
              draft={model.thread.draft}
              onDraft={model.setDraft}
              attachments={model.thread.attachments}
              onAddAttachment={(text: string): 'added' | 'truncated' | 'full' =>
                model.addAttachment({ kind: 'text', text })
              }
              onPickFile={
                supportsFileAttachment()
                  ? (): Promise<string | null> => attachChatFiles(model)
                  : undefined
              }
              onDropFiles={
                supportsAttachmentDrop()
                  ? (files: File[]): Promise<string | null> =>
                      attachChatFiles(model, files)
                  : undefined
              }
              onRemoveAttachment={model.removeAttachment}
              template={model.thread.template}
              onTemplate={model.setTemplate}
              webEnabled={model.thread.webEnabled}
              webQuery={model.thread.webQuery}
              onWebEnabled={model.setWebEnabled}
              onWebQuery={model.setWebQuery}
              providerName={provider}
              models={modelOptions}
              currentModel={currentModel}
              onModel={(value: string): void => {
                void model.selectModel(value);
              }}
              modelDisabled={modelDisabled}
              scope={
                model.thread.documents.length > 0
                  ? {
                      names: model.thread.documents.map(
                        (path: string): string => documentDisplayName(path),
                      ),
                      onClear: model.clearDocumentScope,
                      clearDisabled: scopeDisabled,
                    }
                  : null
              }
              locked={aiUnavailable}
              disabled={
                model.busy ||
                !model.ready ||
                model.invalidScope ||
                aiUnavailable
              }
              canSend={canSend}
              running={running}
              inConversation={turns.length > 0}
              afterError={!!(model.error || failedRun)}
              sessionHint={sessionContinuationHint({
                messages: turns.length,
                unavailable:
                  aiUnavailable ||
                  !!problem ||
                  !!model.pending ||
                  loading ||
                  !canWrite,
                working,
                resumable: model.resumable,
                replaying: running && model.run?.local.historyReplayed === true,
                restarted:
                  model.run?.local.resumeFailed === true &&
                  (!model.busy || running),
              })}
              fileHint={
                latest?.role === 'assistant' &&
                splitOutputDirective(latest.content).format !== null
              }
              stopping={model.run?.local.status === 'stopping'}
              onSend={sendQuestion}
              onStop={(): void => {
                void model.cancel();
              }}
              textareaRef={textarea}
              onKeyDown={handleKey}
            />
            {downloadError && (
              <StatusNotice
                variant="box"
                tone="warning"
                className={styles.footerNotice}
              >
                {downloadError}
              </StatusNotice>
            )}
          </>
        )}
      </div>
      {evidence && !model.invalidScope && !navigationError && (
        <ChatEvidencePanel
          panelRef={evidencePane}
          visible={evidenceVisible}
          narrow={layout === 'narrow'}
          title={evidence.title}
          searchSummary={selectedTurn?.id === latest?.id ? latestSearch : ''}
          citations={evidence.citations}
          total={selectedCitations.length}
          all={location.evidence === 'all'}
          loading={model.loading}
          onClose={closeEvidence}
          onSelect={(index?: number): void => {
            if (selectedTurn) selectEvidence(selectedTurn, index);
          }}
        />
      )}
    </section>
  );
}
