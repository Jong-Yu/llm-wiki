import { useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  JSX,
  KeyboardEvent,
  RefObject,
  SubmitEvent,
} from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import type { AiModelOption } from '../model/aiModelOptions';
import { templateById } from '../model/answerTemplates';
import {
  ATTACHMENT_FULL_MESSAGE,
  ATTACHMENT_ITEM_LIMIT,
  ATTACHMENT_TOTAL_LIMIT,
  shouldBecomeChip,
  totalCharacters,
} from '../model/attachments';
import type { ChatAttachment } from '../model/attachments';
import { AttachmentChips } from './AttachmentChips';
import { ComposerMenu } from './ComposerMenu';
import { ComposerWebSearch } from './ComposerWebSearch';
import styles from './ChatComposer.module.scss';

type AddResult = 'added' | 'truncated' | 'full';
type ChatComposerProps = {
  draft: string;
  onDraft: (value: string) => void;
  attachments: readonly ChatAttachment[];
  onAddAttachment: (text: string) => AddResult;
  /** 파일 선택 대화상자를 열어 읽고 첨부합니다. 사용자에게 보일 안내 문장을 돌려주며, 없으면 파일 첨부 항목을 숨깁니다. */
  onPickFile?: () => Promise<string | null>;
  /** 놓은 파일을 한 번에 첨부하고 표시할 안내를 돌려줍니다. */
  onDropFiles?: (files: File[]) => Promise<string | null>;
  onRemoveAttachment: (id: string) => void;
  template: string;
  onTemplate: (id: string) => void;
  webEnabled: boolean;
  webQuery: string;
  onWebEnabled: (value: boolean) => void;
  onWebQuery: (value: string) => void;
  /** AI 이름(예: Claude Code)과 선택한 모델입니다. 안내 문구와 ＋ 메뉴에 보입니다. */
  providerName: string;
  models: readonly AiModelOption[];
  currentModel: string;
  onModel: (value: string) => void;
  modelDisabled: boolean;
  /** 질문 범위가 고정된 경우의 문서 이름과 해제 동작입니다. */
  scope: {
    names: string[];
    onClear: () => void;
    clearDisabled: boolean;
  } | null;
  /** 입력을 막는 이유(연결 필요·준비 중 등)입니다. 막혀 있으면 문구를 바꾸고 옵션을 숨깁니다. */
  locked: boolean;
  disabled: boolean;
  canSend: boolean;
  running: boolean;
  /** 이미 오간 대화가 있는지입니다. 있으면 "이어서 질문하세요"로 안내합니다. */
  inConversation: boolean;
  /** 마지막 오류 뒤라면 "질문을 수정해서 다시 보낼 수도 있어요"로 안내합니다. */
  afterError: boolean;
  /** 마지막 답변이 파일 형식 요청에 답한 것이면 형식 추천 안내를 보입니다. */
  fileHint: boolean;
  /** 부모가 현재 대화 상태에 맞게 고른 하단 안내입니다. */
  sessionHint: string | null;
  stopping: boolean;
  onSend: () => void;
  onStop: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

/**
 * 질문·첨부와 보내기를 조합하고, 답변 양식·모델·웹 설정은 각 도구에 맡깁니다.
 * 긴 글을 붙여넣으면 입력창에 풀지 않고 첨부 칩으로 접습니다.
 */
export function ChatComposer({
  draft,
  onDraft,
  attachments,
  onAddAttachment,
  onPickFile,
  onDropFiles,
  onRemoveAttachment,
  template,
  onTemplate,
  webEnabled,
  webQuery,
  onWebEnabled,
  onWebQuery,
  providerName,
  models,
  currentModel,
  onModel,
  modelDisabled,
  scope,
  locked,
  disabled,
  canSend,
  running,
  inConversation,
  afterError,
  fileHint,
  sessionHint,
  stopping,
  onSend,
  onStop,
  textareaRef,
  onKeyDown,
}: ChatComposerProps): JSX.Element {
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readInFlight = useRef(false);
  const optionsDisabled = disabled || running || locked || reading;
  const total = totalCharacters(attachments);
  const selectedTemplate = templateById(template);
  const modelLabel = currentModel === 'default' ? '' : ` · ${currentModel}`;

  const fileActions = [onPickFile && '＋', onDropFiles && '끌어다 놓기']
    .filter(Boolean)
    .join(' 또는 ');
  const attachmentHint =
    '긴 글은 붙여넣으면 자동으로 칩이 됩니다' +
    (fileActions ? ` · 파일은 ${fileActions}` : '');

  /** 파일 선택과 드롭이 겹쳐 같은 첨부 한도를 동시에 쓰지 않도록 한 번에 하나만 읽습니다. */
  async function readFiles(read: () => Promise<string | null>): Promise<void> {
    if (optionsDisabled || readInFlight.current) return;
    readInFlight.current = true;
    setReading(true);
    setNotice(null);
    try {
      setNotice(await read());
    } catch {
      setNotice('파일을 첨부하지 못했어요.');
    } finally {
      readInFlight.current = false;
      setReading(false);
    }
  }

  /** 파일을 놓을 때만 브라우저가 파일을 여는 기본 동작을 막습니다. */
  function dragFiles(event: DragEvent<HTMLFormElement>): void {
    if (!onDropFiles || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = optionsDisabled ? 'none' : 'copy';
  }

  /** 보호 모드가 풀린 drop 시점에 전체 파일 목록을 복사합니다. */
  function dropFiles(event: DragEvent<HTMLFormElement>): void {
    if (!onDropFiles || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    if (files.length)
      void readFiles((): Promise<string | null> => onDropFiles(files));
  }

  /** 붙여넣은 자료의 한도를 확인한 결과를 같은 위치에 표시합니다. */
  function addText(text: string): void {
    const result = onAddAttachment(text);
    setNotice(
      result === 'full'
        ? ATTACHMENT_FULL_MESSAGE
        : result === 'truncated'
          ? `너무 길어 앞부분만 담았어요 (한 번에 최대 ${ATTACHMENT_ITEM_LIMIT.toLocaleString()}자).`
          : null,
    );
  }
  /** 짧은 텍스트는 기본 붙여넣기를 사용해 커서 위치와 선택 범위를 보존합니다. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const text = event.clipboardData.getData('text');
    if (!shouldBecomeChip(text)) return;
    event.preventDefault();
    addText(text);
  }

  return (
    <div className={styles.wrap}>
      <form
        onDragOver={dragFiles}
        onDrop={dropFiles}
        className={`${styles.composer} ${locked ? styles.locked : ''}`}
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          event.preventDefault();
          if (canSend && !readInFlight.current) onSend();
        }}
      >
        {scope && (
          <div className={styles.scope}>
            <span>질문 범위: {scope.names.join(', ')}</span>
            <button
              className={styles.link}
              type="button"
              disabled={scope.clearDisabled}
              onClick={scope.onClear}
            >
              전체 문서에서 찾기
            </button>
          </div>
        )}
        {(attachments.length > 0 || selectedTemplate) && (
          <div className={styles.chipRow}>
            {selectedTemplate && (
              <span className={styles.option}>
                양식: {selectedTemplate.name}
                <button
                  type="button"
                  aria-label="답변 양식 지우기"
                  onClick={(): void => onTemplate('')}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
            <AttachmentChips
              items={attachments}
              onRemove={onRemoveAttachment}
              removeDisabled={reading}
              className={styles.attachments}
            />
          </div>
        )}
        <label htmlFor="knowledge-chat-question" className={styles.srOnly}>
          질문
        </label>
        <textarea
          ref={textareaRef}
          id="knowledge-chat-question"
          aria-describedby="knowledge-chat-hint"
          className={styles.input}
          value={draft}
          maxLength={16000}
          rows={1}
          placeholder={
            locked
              ? '질문을 입력하세요'
              : running
                ? '답변이 끝나면 이어서 질문할 수 있어요'
                : afterError
                  ? '질문을 수정해서 다시 보낼 수도 있어요'
                  : attachments.length > 0
                    ? '첨부한 자료에 대해 질문하세요'
                    : inConversation
                      ? '이어서 질문하세요'
                      : '문서에 대해 질문하세요'
          }
          disabled={disabled || reading}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
            onDraft(event.currentTarget.value)
          }
          onPaste={paste}
          onKeyDown={onKeyDown}
        />
        {reading && (
          <p className={styles.reading} role="status">
            <Icon name="loader-circle" size={13} className={styles.spin} />{' '}
            파일을 읽는 중이에요…
          </p>
        )}
        {notice && !reading && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        <div className={styles.toolbar}>
          <ComposerMenu
            disabled={optionsDisabled}
            template={template}
            onTemplate={onTemplate}
            models={models}
            currentModel={currentModel}
            onModel={onModel}
            modelDisabled={modelDisabled}
            onPasteText={addText}
            onPickFile={
              onPickFile &&
              ((): void => {
                void readFiles(onPickFile);
              })
            }
          />
          {!locked && (
            <ComposerWebSearch
              enabled={webEnabled}
              query={webQuery}
              disabled={optionsDisabled}
              onEnabledChange={onWebEnabled}
              onQueryChange={onWebQuery}
            />
          )}
          {attachments.length > 0 && (
            <span className={styles.counter}>
              합계 {total.toLocaleString()} /{' '}
              {ATTACHMENT_TOTAL_LIMIT.toLocaleString()}자
            </span>
          )}
          {running ? (
            <button
              type="button"
              className={`${styles.send} ${styles.stop}`}
              aria-label="응답 중단"
              disabled={stopping}
              onClick={onStop}
            >
              <Icon name="square" size={12} />
            </button>
          ) : (
            <button
              type="submit"
              className={styles.send}
              aria-label="질문 보내기"
              disabled={!canSend || reading}
            >
              <Icon name="arrow-up" size={16} />
            </button>
          )}
        </div>
      </form>
      <p id="knowledge-chat-hint" className={styles.hint}>
        {sessionHint ??
          (running
            ? '중단 버튼으로 멈출 수 있어요'
            : locked
              ? '연결하면 입력창이 열려요'
              : attachments.length > 0
                ? attachmentHint
                : fileHint
                  ? '형식을 말하지 않으면 글로 답하고, 내려받기에서 어울리는 형식을 추천해요'
                  : `Enter 전송 · Shift+Enter 줄바꿈 · ${providerName}${modelLabel}`)}
      </p>
    </div>
  );
}
