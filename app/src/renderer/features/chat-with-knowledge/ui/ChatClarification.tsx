import { useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  JSX,
  KeyboardEvent,
  RefObject,
  SubmitEvent,
} from 'react';
import type { QuestionClarificationOptionDetail } from '@contracts/questionRuns.contract';
import type { ChatTurn } from '../model/chatState';
import { AssistantMessage } from './AssistantMessage';
import { ChatAnswer } from './ChatAnswer';
import styles from './KnowledgeChat.module.scss';

type ClarificationFormProps = {
  turn: ChatTurn;
  awaiting: true;
  draft: string;
  onDraft: (value: string) => void;
  disabled: boolean;
  canSend: boolean;
  onSend: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};
type ChatClarificationProps =
  | ClarificationFormProps
  | {
      turn: ChatTurn;
      awaiting: false;
    };

/** 같은 초안을 단일 선택 또는 직접 입력으로 읽으며 제출 전에는 AI를 실행하지 않습니다. */
function ClarificationForm({
  turn,
  draft,
  onDraft,
  disabled,
  canSend,
  onSend,
  textareaRef,
  onKeyDown,
}: ClarificationFormProps): JSX.Element {
  const formId = useId();
  const focusDirect = useRef(false);
  const [forceDirect, setForceDirect] = useState(false);
  const options = turn.clarification?.options ?? [];
  const selected = options.indexOf(draft);
  // 직접 입력 도중 선택지와 같은 접두어가 완성돼도 입력창·IME 조합을 없애지 않습니다.
  const direct = forceDirect || selected === -1;

  useLayoutEffect((): void => {
    if (direct && focusDirect.current) {
      textareaRef.current?.focus();
      focusDirect.current = false;
    }
  }, [direct, textareaRef]);

  /** 이미 작성한 자유 답변은 유지하고, 선택지를 직접 고치려 할 때에만 빈 입력을 엽니다. */
  function chooseDirect(): void {
    if (disabled) return;
    setForceDirect(true);
    if (direct) {
      textareaRef.current?.focus();
      return;
    }
    focusDirect.current = true;
    onDraft('');
  }

  return (
    <form
      className={`${styles.clarification} ${styles.clarificationDock}`}
      aria-label="AI 추가 질문"
      data-chat-clarification
      data-chat-awaiting-input
      onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (!disabled && canSend) onSend();
      }}
    >
      <header className={styles.clarificationHeader}>
        <span>추가 질문</span>
        <span role="status">답변을 기다리고 있어요</span>
      </header>
      <div className={styles.clarificationBody}>
        <div id={`${formId}-question`}>
          <ChatAnswer content={turn.content} />
        </div>
        {options.length > 0 && (
          <fieldset
            className={styles.clarificationChoices}
            disabled={disabled}
            aria-describedby={`${formId}-question`}
          >
            <legend className={styles.srOnly}>답변 선택</legend>
            {options.map((option: string, index: number): JSX.Element => {
              const optionId = `${formId}-option-${index}`;
              const detail = turn.clarification?.option_details?.find(
                (item: QuestionClarificationOptionDetail): boolean =>
                  item.option === option,
              );
              return (
                <label
                  key={index}
                  className={styles.clarificationChoice}
                  data-selected={(!direct && selected === index) || undefined}
                >
                  <input
                    type="radio"
                    name={formId}
                    value={option}
                    aria-labelledby={`${optionId}-label`}
                    aria-describedby={
                      detail
                        ? `${optionId}-description${detail.recommended ? ` ${optionId}-recommendation` : ''}`
                        : undefined
                    }
                    checked={!direct && selected === index}
                    onChange={(): void => {
                      setForceDirect(false);
                      onDraft(option);
                    }}
                  />
                  <span className={styles.clarificationChoiceText}>
                    <span className={styles.clarificationChoiceHeading}>
                      <span id={`${optionId}-label`}>{option}</span>
                      {detail?.recommended && (
                        <span
                          id={`${optionId}-recommendation`}
                          className={styles.clarificationRecommendation}
                        >
                          AI 추천
                        </span>
                      )}
                    </span>
                    {detail && (
                      <span
                        id={`${optionId}-description`}
                        className={styles.clarificationDescription}
                      >
                        {detail.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <label
              className={styles.clarificationChoice}
              data-selected={direct || undefined}
            >
              <input
                type="radio"
                name={formId}
                value="direct"
                checked={direct}
                onChange={chooseDirect}
                onClick={(): void => {
                  if (direct) textareaRef.current?.focus();
                }}
              />
              <span>직접 입력</span>
            </label>
          </fieldset>
        )}
        {(direct || options.length === 0) && (
          <div className={styles.clarificationInput}>
            <label htmlFor={`${formId}-answer`} className={styles.srOnly}>
              답변
            </label>
            <textarea
              ref={textareaRef}
              id={`${formId}-answer`}
              aria-describedby={`${formId}-question`}
              value={draft}
              placeholder="답변을 입력하세요"
              maxLength={16000}
              rows={3}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
                setForceDirect(true);
                onDraft(event.currentTarget.value);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
        )}
      </div>
      <footer className={styles.clarificationFooter}>
        <button
          type="submit"
          className={`${styles.button} ${styles.primaryAction}`}
          disabled={disabled || !canSend}
        >
          답변 보내기
        </button>
      </footer>
    </form>
  );
}

/** 활성 질문은 입력창 자리에 폼으로, 답변한 질문은 대화 이력에 본문만 남깁니다. */
export function ChatClarification(props: ChatClarificationProps): JSX.Element {
  if (props.awaiting) return <ClarificationForm {...props} />;
  return (
    <AssistantMessage>
      <section aria-label="AI 추가 질문" data-chat-clarification>
        <ChatAnswer content={props.turn.content} />
      </section>
    </AssistantMessage>
  );
}
