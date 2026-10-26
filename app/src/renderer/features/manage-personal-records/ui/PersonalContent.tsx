import type { ComponentPropsWithoutRef, JSX } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './ManagePersonalRecords.module.scss';

type PersonalContentProps = { content: string };
/** 개인 기록의 링크는 표시만 하며 외부 페이지나 앱 명령으로 실행하지 않습니다. */
function StoredLink({ children }: ComponentPropsWithoutRef<'a'>): JSX.Element {
  return <span className={styles.storedLink}>{children}</span>;
}
/** 저장된 이미지 URL을 자동 요청하지 않고 대체 설명을 표시합니다. */
function StoredImage({ alt }: ComponentPropsWithoutRef<'img'>): JSX.Element {
  return <span>[이미지: {alt || '설명 없음'}]</span>;
}
/** HTML 실행과 외부 미디어 요청 없이 저장된 Markdown을 읽습니다. */
export function PersonalContent({
  content,
}: PersonalContentProps): JSX.Element {
  return (
    <div className={styles.markdown}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{ a: StoredLink, img: StoredImage }}
      >
        {content}
      </Markdown>
    </div>
  );
}
