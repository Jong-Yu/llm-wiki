import { Children, useEffect, useRef } from 'react';
import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';
import type { Root, RootContent } from 'hast';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DocumentEvidenceMatch } from '@renderer/shared/lib/documentEvidence';
import styles from './ManageDocumentContent.module.scss';

type DocumentMarkdownProps = {
  content: string;
  bodyStartLine?: number;
  evidence?: DocumentEvidenceMatch | null;
  evidenceKey?: string;
  active?: boolean;
};
type TextLinkProps = ComponentPropsWithoutRef<'a'> & ExtraProps;
type TextImageProps = ComponentPropsWithoutRef<'img'> & ExtraProps;
type TextCodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps;
/** 본문 링크는 데이터로 표시하며 외부 실행·탐색을 자동으로 시작하지 않습니다. */
function TextLink({ children, href }: TextLinkProps): JSX.Element {
  return (
    <span className={styles.textLink}>
      {children}
      {href && <small> ({href})</small>}
    </span>
  );
}
/** 원격 이미지를 요청하지 않아 문서 열람이 외부 전송을 만들지 않습니다. */
function TextImage({ alt, src }: TextImageProps): JSX.Element {
  return (
    <span className={styles.imageText}>
      이미지 · {alt || '설명 없음'}
      {typeof src === 'string' && <small> ({src})</small>}
    </span>
  );
}
/** 긴 코드 원문도 해당 행으로 이동하도록 텍스트와 개행을 그대로 나눠 표시합니다. */
function TextCode({ node, children, ...props }: TextCodeProps): JSX.Element {
  const firstLine = node?.properties.dataSourceCodeStartLine;
  const parts = Children.toArray(children);
  if (
    typeof firstLine !== 'number' ||
    !parts.every((part: ReactNode): part is string => typeof part === 'string')
  )
    return <code {...props}>{children}</code>;
  const lines = parts.join('').split('\n');
  return (
    <code {...props}>
      {lines.map((text: string, index: number): JSX.Element => (
        <span
          key={index}
          data-source-start-line={firstLine + index}
          data-source-end-line={firstLine + index}
        >
          {text}
          {index < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </code>
  );
}
/** 표시 전용 URL은 원문 그대로 남깁니다. */
function textUrl(url: string): string {
  return url;
}
const components: Components = { a: TextLink, img: TextImage, code: TextCode };
const plugins = [remarkGfm];
const positionTags = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'pre',
  'li',
  'blockquote',
  'table',
  'td',
  'th',
]);

/** Markdown 블록에 원본 파일 행 좌표를 붙이며 HTML 원문은 실행하지 않습니다. */
function sourcePositions(options: {
  bodyStartLine: number;
  content: string;
}): (tree: Root) => void {
  return (tree: Root): void => {
    const source = options.content.split(/\r\n|\r|\n/);
    function visit(node: Root | RootContent): void {
      if (
        node.type === 'element' &&
        node.position &&
        positionTags.has(node.tagName)
      ) {
        node.properties.dataSourceStartLine =
          node.position.start.line + options.bodyStartLine - 1;
        node.properties.dataSourceEndLine =
          node.position.end.line + options.bodyStartLine - 1;
        if (node.tagName === 'pre') {
          const code = node.children.find(
            (child: RootContent): boolean =>
              child.type === 'element' && child.tagName === 'code',
          );
          if (code?.type === 'element')
            code.properties.dataSourceCodeStartLine =
              node.position.start.line +
              options.bodyStartLine -
              1 +
              (/^\s*(?:`{3,}|~{3,})/.test(
                source[node.position.start.line - 1] ?? '',
              )
                ? 1
                : 0);
        }
      }
      if ('children' in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}

/** 안전한 Markdown으로 저장된 본문을 표시하며 HTML을 실행하지 않습니다. */
export function DocumentMarkdown({
  content,
  bodyStartLine = 1,
  evidence = null,
  evidenceKey = 'document-evidence',
  active = true,
}: DocumentMarkdownProps): JSX.Element {
  const article = useRef<HTMLElement>(null);
  const revealed = useRef<string | null>(null);
  useEffect((): (() => void) | undefined => {
    if (!active || evidence?.status !== 'matched' || !article.current) return;
    const blocks = [
      ...article.current.querySelectorAll<HTMLElement>(
        '[data-source-start-line]',
      ),
    ];
    const matching = blocks.filter((element: HTMLElement): boolean => {
      const start = Number(element.dataset.sourceStartLine);
      const end = Number(element.dataset.sourceEndLine);
      return start <= evidence.startLine && end >= evidence.startLine;
    });
    matching.sort(
      (a: HTMLElement, b: HTMLElement): number =>
        Number(a.dataset.sourceEndLine) -
        Number(a.dataset.sourceStartLine) -
        (Number(b.dataset.sourceEndLine) - Number(b.dataset.sourceStartLine)),
    );
    const target = matching[0];
    if (!target) return;
    target.dataset.evidenceTarget = 'true';
    target.tabIndex = -1;
    if (revealed.current !== evidenceKey) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      target.focus({ preventScroll: true });
      revealed.current = evidenceKey;
    }
    return (): void => {
      delete target.dataset.evidenceTarget;
      target.removeAttribute('tabindex');
    };
  }, [content, bodyStartLine, evidence, evidenceKey, active]);
  return (
    <article
      ref={article}
      className={styles.markdown}
      aria-label="저장된 문서 본문"
    >
      {content.length === 0 ? (
        <div className={styles.empty}>
          <h2>본문이 비어 있습니다</h2>
          <p>
            문서를 읽었지만 아직 표시할 본문이 없습니다. 본문 편집으로 내용을
            작성할 수 있습니다.
          </p>
        </div>
      ) : (
        <Markdown
          remarkPlugins={plugins}
          rehypePlugins={
            evidence?.status === 'matched'
              ? [[sourcePositions, { bodyStartLine, content }]]
              : undefined
          }
          components={components}
          urlTransform={textUrl}
        >
          {content}
        </Markdown>
      )}
    </article>
  );
}
