import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import type { QuestionContent } from '../model/externalMaterial';
import styles from './KnowledgeChat.module.scss';
import { AttachmentChips } from './AttachmentChips';
type ChatQuestionMessageProps = { question: QuestionContent };
/** 저장된 질문과 그때 보낸 첨부·양식을 함께 표시합니다. */
export function ChatQuestionMessage({
  question: { question, template, attachments, registeredTemplate },
}: ChatQuestionMessageProps): JSX.Element {
  const bodyId = useId();
  const body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect((): (() => void) | undefined => {
    const element = body.current;
    if (!element) return;
    /** 실제 글줄 높이로 판정하여 짧은 줄바꿈·넓은 글자·창 폭 변화도 반영합니다. */
    const measure = (): void => {
      if (element.clientWidth === 0) return;
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      setOverflow(element.scrollHeight > lineHeight * 6 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [question]);

  return (
    <article className={styles.user}>
      <span className={styles.srOnly}>나</span>
      <div className={styles.questionBubble}>
        <p
          ref={body}
          id={bodyId}
          className={styles.questionText}
          data-collapsed={!expanded || undefined}
        >
          {question}
        </p>
        {overflow && (
          <button
            type="button"
            className={styles.questionToggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={(): void => setExpanded(!expanded)}
          >
            {expanded ? '접기' : '더 보기'}
            <Icon name="chevron-down" size={14} />
          </button>
        )}
      </div>
      {template && (
        <small className={styles.templateTag}>
          {registeredTemplate ? '템플릿' : '답변 양식'} ·{' '}
          {template.name ?? '삭제된 양식'}
        </small>
      )}
      <AttachmentChips
        items={attachments}
        expandable
        className={styles.bubbleChips}
      />
    </article>
  );
}
