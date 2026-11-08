import type { ComponentPropsWithoutRef, JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './ChatAnswer.module.scss';

type ChatAnswerProps = { content: string; secondaryEnding?: boolean };
/** 답변에 들어 있는 외부 링크를 실행하거나 미디어를 자동 전송하지 않습니다. */
function AnswerLink({ children }: ComponentPropsWithoutRef<'a'>): JSX.Element {
  return <span>{children}</span>;
}
/** 이미지 주소는 네트워크 요청 없이 대체 설명으로 보여 줍니다. */
function AnswerImage({ alt }: ComponentPropsWithoutRef<'img'>): JSX.Element {
  return <span>[이미지: {alt || '설명 없음'}]</span>;
}
/** 넓은 표만 답변 안에서 가로로 읽도록 표의 행과 열은 그대로 유지합니다. */
function AnswerTable({
  children,
}: ComponentPropsWithoutRef<'table'>): JSX.Element {
  return (
    <div className={styles.tableScroll}>
      <table>{children}</table>
    </div>
  );
}
/** 모델 출력의 HTML을 실행하지 않는 읽기 전용 Markdown 본문입니다. */
export function ChatAnswer({
  content,
  secondaryEnding = false,
}: ChatAnswerProps): JSX.Element {
  return (
    <div
      className={styles.markdown}
      data-secondary-ending={secondaryEnding || undefined}
    >
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{ a: AnswerLink, img: AnswerImage, table: AnswerTable }}
      >
        {content}
      </Markdown>
    </div>
  );
}
