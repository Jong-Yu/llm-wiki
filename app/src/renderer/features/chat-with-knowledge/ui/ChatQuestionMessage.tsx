import type { JSX } from 'react';
import type { QuestionContent } from '../model/externalMaterial';
import styles from './KnowledgeChat.module.scss';
import { AttachmentChips } from './AttachmentChips';
type ChatQuestionMessageProps = { question: QuestionContent };
/** 저장된 질문과 그때 보낸 첨부·양식을 함께 표시합니다. */
export function ChatQuestionMessage({
  question: { question, template, attachments },
}: ChatQuestionMessageProps): JSX.Element {
  return (
    <article className={styles.user}>
      <span className={styles.srOnly}>나</span>
      <p>{question}</p>
      {template && (
        <small className={styles.templateTag}>
          답변 양식 · {template.name ?? '삭제된 양식'}
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
