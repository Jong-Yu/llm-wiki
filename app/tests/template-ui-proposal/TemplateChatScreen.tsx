import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import type { ExportFormat } from '@contracts/fileExports.contract';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useChatPanes } from '@renderer/features/chat-with-knowledge/ui/useChatPanes';
import type { ChatLocation } from '@renderer/features/chat-with-knowledge/model/chatNavigation';
import { ChatComposer } from '@renderer/features/chat-with-knowledge/ui/ChatComposer';
import { ChatHistoryPanel } from '@renderer/features/chat-with-knowledge/ui/ChatHistoryPanel';
import { ChatQuestionMessage } from '@renderer/features/chat-with-knowledge/ui/ChatQuestionMessage';
import { ChatReply } from '@renderer/features/chat-with-knowledge/ui/ChatReply';
import {
  emptyChat,
  chatId,
} from '@renderer/features/chat-with-knowledge/model/chatState';
import type {
  ChatThread,
  ChatTurn,
} from '@renderer/features/chat-with-knowledge/model/chatState';
import type { QuestionContent } from '@renderer/features/chat-with-knowledge/model/externalMaterial';
import {
  fitAttachment,
  nextPastedName,
} from '@renderer/features/chat-with-knowledge/model/attachments';
import type { ChatAttachment } from '@renderer/features/chat-with-knowledge/model/attachments';
import { aiModelOptions } from '@renderer/features/chat-with-knowledge/model/aiModelOptions';
import chatStyles from '@renderer/features/chat-with-knowledge/ui/KnowledgeChat.module.scss';
import type { SavedTemplate } from './ReusableTemplateModel';
import {
  templateById,
  templateOutputFormat,
  updateSavedTemplates,
} from './templateCatalog';
import styles from './TemplateChatScreen.module.scss';

export type TemplateChatScreenProps = {
  templates: SavedTemplate[];
  selectedId: string;
  onSelect: (id: string) => void;
};
type ExampleExchange = {
  question: QuestionContent;
  answer: ChatTurn;
  snapshot: SavedTemplate | null;
  rules: string;
};
type ExampleThread = { chat: ChatThread; exchanges: ExampleExchange[] };

const examples = [
  '최근에 바뀐 문서가 뭐야?',
  '두 문서를 비교해 줘',
  '이 위키에 어떤 내용이 있어?',
];

/** 고정 Nori 예시 본문으로 파일 카드의 모습만 보여 주며 사용자 요청을 생성했다고 주장하지 않습니다. */
function exampleAnswer(format: ExportFormat | null, selected: boolean): string {
  if (!selected)
    return 'Nori 프로젝트에는 아키텍처, UI/UX 가이드, 권한 정책이 정리되어 있습니다.\n\n시안의 고정 응답 예시입니다. 실제 질문에 대한 검색·AI 답변은 실행하지 않았습니다.';
  if (!format)
    return '선택한 템플릿과 지침을 요청에 연결했습니다.\n\n이 파일 형식의 결과 미리보기는 시안에 연결하지 않았습니다. 실제 파일 생성·서식 보존·지침 검사는 실행하지 않았습니다.';
  return `[[파일: ${format}]]
# Nori 문서 상세 화면 설계서 예시

선택한 양식을 사용하는 산출물이 이 대화 안에 표시되는 예시입니다. 실제 파일 생성·서식 보존·지침 검사는 실행하지 않았습니다.

## 화면 개요
문서 내용과 상태를 확인하고 관련 근거를 탐색하는 화면입니다.

## 구성 요소
| 영역 | 표시 내용 | 동작 |
| --- | --- | --- |
| 제목 | 문서명·상태 | 이력 확인 |
| 본문 | 문서 내용 | 근거 확인 |
| 속성 | 작성자·관련 문서 | 상세 열기 |

## 예외 상태
잠김·접근 불가·불러오기 실패의 안내 위치를 구분합니다.

이 본문은 Nori 고정 예시이며 임의 요청이나 업로드한 양식에 맞춘 생성 결과가 아닙니다.`;
}

/** 기존 채팅 부품과 외형을 재사용하며 선택한 양식의 요청·결과 흐름만 메모리로 시연합니다. */
export function TemplateChatScreen({
  templates,
  selectedId,
  onSelect,
}: TemplateChatScreenProps): JSX.Element {
  updateSavedTemplates(templates);
  const [threads, setThreads] = useState<ExampleThread[]>(
    (): ExampleThread[] => [{ chat: emptyChat(), exchanges: [] }],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const current =
    threads.find(
      (thread: ExampleThread): boolean => thread.chat.id === activeId,
    ) ?? threads[0];
  const [paneLocation, setPaneLocation] = useState<ChatLocation>({});
  const {
    workspace,
    historyPane,
    conversationPane,
    layout,
    historyVisible,
    conversationVisible,
    setHistoryOpen,
    rememberFocus,
  } = useChatPanes(paneLocation, false, '', setPaneLocation);
  const [model, setModel] = useState('default');
  const [notice, setNotice] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const exchangeCount = current?.exchanges.length ?? 0;

  useLayoutEffect((): void => {
    const panel = messages.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [activeId, exchangeCount]);

  if (!current) return <p>대화 예시를 준비하지 못했습니다.</p>;
  const threadId = current.chat.id;
  const historyThreads = threads
    .map((thread: ExampleThread): ChatThread => thread.chat)
    .filter((chat: ChatThread): boolean =>
      Boolean(chat.conversationId || chat.draft),
    );
  const canSend = current.chat.draft.trim().length > 0;

  /** 현재 대화의 초안만 바꾸어 다른 대화의 입력과 결과를 보존합니다. */
  function patchChat(patch: Partial<ChatThread>): void {
    setThreads((items: ExampleThread[]): ExampleThread[] =>
      items.map((thread: ExampleThread): ExampleThread =>
        thread.chat.id === threadId
          ? { ...thread, chat: { ...thread.chat, ...patch } }
          : thread,
      ),
    );
  }
  /** 선택한 파일과 룰은 보내는 순간 복사하고 이후 관리 화면 편집과 구별합니다. */
  function send(): void {
    if (!current || !current.chat.draft.trim()) return;
    const chosen = templates.find(
      (template: SavedTemplate): boolean => template.id === selectedId,
    );
    const catalog = templateById(selectedId);
    const format = chosen
      ? templateOutputFormat(chosen.fileName)
      : (catalog?.suggestedFormat ?? null);
    const exchange: ExampleExchange = {
      question: {
        question: current.chat.draft.trim(),
        template: catalog ? { id: catalog.id, name: catalog.name } : null,
        attachments: current.chat.attachments.map(
          (attachment: ChatAttachment): ChatAttachment => ({ ...attachment }),
        ),
        noEvidence: false,
      },
      answer: {
        id: chatId(),
        role: 'assistant',
        content: exampleAnswer(format, Boolean(catalog)),
        status: 'complete',
      },
      snapshot: chosen ? { ...chosen } : null,
      rules: chosen?.rules ?? catalog?.instruction ?? '',
    };
    setThreads((items: ExampleThread[]): ExampleThread[] =>
      items.map((thread: ExampleThread): ExampleThread =>
        thread.chat.id === threadId
          ? {
              chat: {
                ...thread.chat,
                title:
                  thread.exchanges.length === 0
                    ? exchange.question.question.slice(0, 40)
                    : thread.chat.title,
                draft: '',
                attachments: [],
                template: selectedId,
                conversationId: thread.chat.id,
              },
              exchanges: [...thread.exchanges, exchange],
            }
          : thread,
      ),
    );
    setNotice('');
  }
  /** Enter 제출은 IME 입력을 끝낸 뒤에만 처리합니다. */
  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !event.repeat
    ) {
      event.preventDefault();
      send();
    }
  }
  /** 붙여넣기 자료는 기존 제한에 맞춰 같은 첨부 칩으로 표시합니다. */
  function addAttachment(text: string): 'added' | 'truncated' | 'full' {
    if (!current) return 'full';
    const item = fitAttachment(current.chat.attachments, {
      id: chatId(),
      kind: 'text',
      name: nextPastedName(current.chat.attachments),
      text,
    });
    if (!item) return 'full';
    patchChat({ attachments: [...current.chat.attachments, item] });
    return item.truncated ? 'truncated' : 'added';
  }
  /** 파일은 이름만 첨부하며 본문 읽기와 전송을 실행하지 않습니다. */
  async function attachFiles(files: File[]): Promise<string | null> {
    if (!current) return null;
    const attachments = [...current.chat.attachments];
    for (const file of files) {
      const item = fitAttachment(attachments, {
        id: chatId(),
        kind: 'file',
        name: file.name,
        text: '시안 첨부입니다. 파일 본문은 읽지 않았습니다.',
      });
      if (item) attachments.push(item);
    }
    patchChat({ attachments });
    return '시안에서는 파일명만 첨부합니다. 파일 읽기·AI 전송은 실행하지 않습니다.';
  }
  /** 새 대화와 기존 대화 모두 작성 중 초안을 메모리에 남깁니다. */
  function newChat(): void {
    const created: ExampleThread = { chat: emptyChat(), exchanges: [] };
    setThreads((items: ExampleThread[]): ExampleThread[] => [
      created,
      ...items,
    ]);
    setActiveId(created.chat.id);
    setPaneLocation({});
    setNotice('');
    onSelect('');
    textarea.current?.focus();
  }
  /** 기존 대화의 질문·첨부·양식을 함께 복원합니다. */
  function selectThread(id: string): void {
    const target = threads.find(
      (thread: ExampleThread): boolean => thread.chat.id === id,
    );
    if (!target) return;
    patchChat({ template: selectedId });
    setActiveId(id);
    onSelect(target.chat.template);
    setPaneLocation({});
    setNotice('');
  }
  /** 파일 카드는 원래 버튼을 유지하되 실제 파일이 없는 시안의 경계를 알립니다. */
  function download(format: ExportFormat): void {
    setNotice(
      `${format.toUpperCase()} 파일은 생성되지 않았습니다. 이 시안에서는 내려받을 수 없습니다.`,
    );
  }

  return (
    <section
      ref={workspace}
      className={chatStyles.root}
      aria-label="AI 채팅"
      data-layout={layout}
      data-history={historyVisible}
      data-evidence={false}
    >
      <ChatHistoryPanel
        panelRef={historyPane}
        visible={historyVisible}
        narrow={layout === 'narrow'}
        disabled={false}
        threads={historyThreads}
        selected={current.chat.id}
        onClose={(): void => {
          setHistoryOpen(false);
          textarea.current?.focus();
        }}
        onSelect={selectThread}
        onNew={newChat}
      />
      <div
        ref={conversationPane}
        tabIndex={-1}
        onFocusCapture={rememberFocus}
        hidden={!conversationVisible}
        className={chatStyles.column}
        data-start={current.exchanges.length === 0 || undefined}
      >
        <header className={chatStyles.header}>
          <div className={chatStyles.titleGroup}>
            {!historyVisible && (
              <button
                className={`${chatStyles.ghost} ${chatStyles.iconButton}`}
                type="button"
                aria-label="대화 목록 열기"
                aria-expanded={historyVisible}
                aria-controls="chat-history"
                onClick={(): void => setHistoryOpen(true)}
              >
                <Icon name="panel-left" />
              </button>
            )}
            <h1 className={chatStyles.title}>{current.chat.title}</h1>
          </div>
          <div className={chatStyles.actions}>
            <span className={chatStyles.status}>
              <i aria-hidden="true" />
              시안
            </span>
          </div>
        </header>
        <div
          ref={messages}
          className={chatStyles.messages}
          role="log"
          aria-label="질문과 답변"
          aria-live="polite"
          aria-relevant="additions"
        >
          {current.exchanges.length === 0 && (
            <div className={chatStyles.empty}>
              <h2>무엇을 찾아볼까요?</h2>
              <p>위키에 저장된 문서에서 근거를 찾아 답합니다.</p>
              <div className={chatStyles.examples}>
                {examples.map((text: string): JSX.Element => (
                  <button
                    key={text}
                    type="button"
                    className={chatStyles.example}
                    onClick={(): void => {
                      patchChat({ draft: text });
                      textarea.current?.focus();
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {current.exchanges.map((exchange: ExampleExchange): JSX.Element => (
            <div key={exchange.answer.id}>
              <ChatQuestionMessage question={exchange.question} />
              <ChatReply
                turn={exchange.answer}
                citations={[]}
                noWiki={false}
                partialSearch={false}
                title="Nori 문서 상세 화면 설계서 예시"
                disabled={false}
                downloading={false}
                onAsk={(): void => {
                  patchChat({ draft: exchange.question.question });
                  textarea.current?.focus();
                }}
                onEvidence={(): void =>
                  setNotice(
                    '예시 자료입니다. 실제 원문 검색은 실행하지 않았습니다.',
                  )
                }
                onDownload={download}
                onCopyError={(): void =>
                  setNotice('현재 시안 환경에서 복사하지 못했습니다.')
                }
              />
              {exchange.question.template && (
                <details className={styles.snapshot}>
                  <summary>이 요청에 적용한 템플릿·지침</summary>
                  <strong>{exchange.question.template.name}</strong>
                  {exchange.snapshot && (
                    <p>양식 파일: {exchange.snapshot.fileName}</p>
                  )}
                  <p className={styles.rules}>
                    {exchange.rules || '추가 지침 없음'}
                  </p>
                  <small>
                    요청 당시 설정입니다. 실제 생성·지침 검사·서식 검사는
                    미실행입니다.
                  </small>
                </details>
              )}
            </div>
          ))}
        </div>
        <ChatComposer
          draft={current.chat.draft}
          onDraft={(value: string): void => patchChat({ draft: value })}
          attachments={current.chat.attachments}
          onAddAttachment={addAttachment}
          onPickFile={async (): Promise<string | null> => {
            picker.current?.click();
            return null;
          }}
          onDropFiles={attachFiles}
          onRemoveAttachment={(id: string): void =>
            patchChat({
              attachments: current.chat.attachments.filter(
                (item: ChatAttachment): boolean => item.id !== id,
              ),
            })
          }
          template={selectedId}
          onTemplate={(id: string): void => {
            patchChat({ template: id });
            onSelect(id);
          }}
          webEnabled={current.chat.webEnabled}
          onWebEnabled={(value: boolean): void => {
            patchChat({ webEnabled: value });
            setNotice(
              value
                ? '웹 검색 선택 예시입니다. 실제 검색은 실행하지 않습니다.'
                : '',
            );
          }}
          providerName="Claude Code"
          models={aiModelOptions.claude}
          currentModel={model}
          onModel={setModel}
          modelDisabled={false}
          scope={null}
          locked={false}
          disabled={false}
          canSend={canSend}
          running={false}
          inConversation={current.exchanges.length > 0}
          afterError={false}
          fileHint={Boolean(current.exchanges.at(-1)?.snapshot)}
          sessionHint={null}
          stopping={false}
          onSend={send}
          onStop={(): void => {}}
          textareaRef={textarea}
          onKeyDown={handleKey}
        />
        {notice && (
          <StatusNotice
            variant="box"
            tone="warning"
            className={chatStyles.footerNotice}
          >
            {notice}
          </StatusNotice>
        )}
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="참고 파일 첨부"
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          const files = Array.from(event.target.files ?? []);
          void attachFiles(files).then((message: string | null): void =>
            setNotice(message ?? ''),
          );
          event.target.value = '';
        }}
      />
    </section>
  );
}
