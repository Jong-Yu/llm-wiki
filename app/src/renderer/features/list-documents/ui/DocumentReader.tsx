import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import type { DocumentPanelTab } from '../model/documentCatalog';
import Markdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { DocumentListItem } from '../model/useDocumentList';
import type { DocumentPreviewModel } from '../model/useDocumentPreview';
import { documentItemTitle } from '../model/documentCatalog';
import { DocumentIcon } from './DocumentIcon';
import styles from './ListDocuments.module.scss';

type MarkdownLinkProps = ComponentPropsWithoutRef<'a'> & ExtraProps;
type MarkdownImageProps = ComponentPropsWithoutRef<'img'> & ExtraProps;
type DocumentReaderProps = {
  item: DocumentListItem | null;
  content: DocumentPreviewModel;
  tab?: DocumentPanelTab;
  onTabChange?: (tab: DocumentPanelTab) => void;
  panel?: ReactNode;
  onEdit?: () => void;
};
type DocumentBodyProps = {
  item: DocumentListItem;
  content: DocumentPreviewModel;
};

/** 문서의 링크는 이동 없이 텍스트와 원문 주소만 표시합니다. */
function MarkdownLink({ children, href }: MarkdownLinkProps): JSX.Element {
  return (
    <span className={styles.markdownLink}>
      {children}
      {href && <span className={styles.markdownUrl}> ({href})</span>}
    </span>
  );
}

/** 원격 이미지는 요청하지 않고 대체 설명과 주소를 보존합니다. */
function MarkdownImage({ alt, src }: MarkdownImageProps): JSX.Element {
  return (
    <span className={styles.markdownImage}>
      이미지 미리보기 비활성 · {alt || '설명 없는 이미지'}
      {typeof src === 'string' && (
        <span className={styles.markdownUrl}> ({src})</span>
      )}
    </span>
  );
}

/** URL은 정적 텍스트로만 사용하므로 원문을 지우지 않고 그대로 전달합니다. */
function textOnlyUrl(url: string): string {
  return url;
}
const markdownComponents: Components = { a: MarkdownLink, img: MarkdownImage };
const markdownPlugins = [remarkGfm];

/** 로딩/실패와 실제 빈 본문을 구분하며 응답에서 읽은 판본의 내용만 렌더합니다. */
function DocumentBody({ item, content }: DocumentBodyProps): JSX.Element {
  const original = item.kind === 'source';
  const state = content.state;
  if (state.status === 'loading')
    return (
      <StatusNotice
        title={
          original ? '원본을 불러오고 있습니다' : '본문을 불러오고 있습니다'
        }
      >
        {original
          ? '선택한 원본 판본을 확인하고 있습니다.'
          : '선택한 위키의 현재 본문을 확인하고 있습니다.'}
      </StatusNotice>
    );
  if (state.status === 'error') {
    const missing =
      state.error.status === 404 || state.error.code === 'not_found';
    return (
      <StatusNotice
        tone="error"
        title={
          missing
            ? '문서를 찾을 수 없습니다'
            : original
              ? '원본을 불러오지 못했습니다'
              : '본문을 불러오지 못했습니다'
        }
      >
        <p>{state.error.message}</p>
        <p className={styles.trace}>오류 코드: {state.error.code}</p>
        {state.error.traceId && (
          <p className={styles.trace}>문의 코드: {state.error.traceId}</p>
        )}
      </StatusNotice>
    );
  }
  if (state.status !== 'ready')
    return (
      <StatusNotice title="본문 확인 전">
        위키를 선택하면 본문을 불러옵니다.
      </StatusNotice>
    );
  if (
    'previewStatus' in state.content &&
    state.content.previewStatus === 'conversion_required'
  ) {
    return (
      <StatusNotice
        title={`${state.content.format.toUpperCase()} 원본 보관 완료 · 문자·표 변환 준비 전`}
      >
        <p>
          선택한 고정 원본 판본의 형식·크기·무결성을 확인했습니다. 문자·표
          변환이 준비되지 않아 본문 미리보기는 제공하지 않습니다.
        </p>
        <dl>
          <dt>파일 형식</dt>
          <dd>{state.content.format.toUpperCase()}</dd>
          <dt>파일 크기</dt>
          <dd>
            {new Intl.NumberFormat('ko-KR').format(state.content.sizeBytes)} B
          </dd>
          <dt>고정 원본 판본</dt>
          <dd>{state.content.sourceVersion}</dd>
        </dl>
        <p>버전·변경에서 해당 원본 파일 전체를 내려받을 수 있습니다.</p>
      </StatusNotice>
    );
  }
  return (
    <>
      {item.kind === 'wiki' &&
        'revision' in state.content &&
        state.content.revision !== item.revision && (
          <StatusNotice tone="warning" title="목록 이후 본문이 변경되었습니다">
            현재 읽은 판본의 본문을 표시합니다. 목록의 정보는 새로고침으로 다시
            확인할 수 있습니다.
          </StatusNotice>
        )}
      {state.content.content.length === 0 ? (
        <StatusNotice
          title={original ? '원본이 비어 있습니다' : '본문이 비어 있습니다'}
        >
          선택한 자료를 읽었지만 표시할 본문이 없습니다.
        </StatusNotice>
      ) : (
        <article
          className={styles.markdown}
          aria-label={original ? '원본 미리보기' : '위키 본문'}
        >
          {item.kind === 'source' &&
          (item.format === 'txt' || item.sizeBytes > 1024 * 1024) ? (
            <>
              {item.format === 'md' && (
                <p className={styles.caption}>
                  큰 원본은 원문 텍스트로 표시합니다.
                </p>
              )}
              <pre className={styles.plainText}>{state.content.content}</pre>
            </>
          ) : (
            <Markdown
              remarkPlugins={markdownPlugins}
              components={markdownComponents}
              urlTransform={textOnlyUrl}
            >
              {state.content.content}
            </Markdown>
          )}
        </article>
      )}
    </>
  );
}

/** 선택한 자료의 읽기 상태를 중앙 패널에 표시하고 원본과 위키를 구분합니다. */
export function DocumentReader({
  item,
  content,
  tab = 'body',
  onTabChange,
  panel,
  onEdit,
}: DocumentReaderProps): JSX.Element {
  return (
    <section
      className={styles.reader}
      aria-label="문서 영역"
      aria-busy={content.state.status === 'loading'}
    >
      {item ? (
        <>
          <header className={styles.readerHeader}>
            <p className={styles.caption}>
              {item.kind === 'source' ? '등록 원본' : '저장된 위키'}
            </p>
            <h2>{documentItemTitle(item)}</h2>
            <nav
              className={styles.workflowLinks}
              aria-label="선택 자료의 다음 작업"
            >
              <Link
                to={
                  item.kind === 'source'
                    ? `/conversations?sourceId=${encodeURIComponent(item.sourceId)}&sourceVersion=${encodeURIComponent(item.sourceVersion)}&sourceSha256=${encodeURIComponent(item.sourceSha256)}`
                    : `/conversations?document=${encodeURIComponent(item.document)}`
                }
              >
                이 자료로 질문
              </Link>
              {item.kind === 'wiki' && (
                <>
                  <Link
                    to={`/knowledge?document=${encodeURIComponent(item.document)}`}
                  >
                    지식 탐색
                  </Link>
                  <Link
                    to={`/review?document=${encodeURIComponent(item.document)}`}
                  >
                    검토함
                  </Link>
                  <Link
                    to={`/analysis-proposals?document=${encodeURIComponent(item.document)}`}
                  >
                    추출안 비교·적용
                  </Link>
                </>
              )}
            </nav>
            <p className={styles.caption}>
              {item.kind === 'source'
                ? '원본 등록 완료 · 분석 상태는 작업에서 확인'
                : item.sourceStatus === 'unknown'
                  ? '위키 · 연결 기준 확인 전'
                  : '위키 · 원본 미연결'}
            </p>
          </header>
          <div className={styles.contentLabel}>
            <nav
              className={styles.readerTabs}
              role="tablist"
              aria-label="문서 보기"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'body'}
                onClick={(): void => onTabChange?.('body')}
              >
                {item.kind === 'source' ? '원본 미리보기' : '본문'}
              </button>
              {item.kind === 'wiki' && (
                <>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'knowledge'}
                    onClick={(): void => onTabChange?.('knowledge')}
                  >
                    연결된 지식
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'connections'}
                    onClick={(): void => onTabChange?.('connections')}
                  >
                    문서 연결
                  </button>
                </>
              )}
              {item.kind === 'source' && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'conversion'}
                  onClick={(): void => onTabChange?.('conversion')}
                >
                  문자 변환
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'versions'}
                onClick={(): void => onTabChange?.('versions')}
              >
                버전·변경
              </button>
            </nav>
            {tab === 'body' && (
              <>
                {onEdit && (
                  <Button variant="secondary" onClick={onEdit}>
                    본문 편집
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={content.retry}
                  disabled={content.state.status === 'loading'}
                >
                  {item.kind === 'source'
                    ? '원본 다시 불러오기'
                    : '본문 다시 불러오기'}
                </Button>
              </>
            )}
          </div>
          <div
            className={styles.readerScroll}
            role="region"
            aria-label="문서 본문"
            tabIndex={0}
          >
            {tab === 'body' ? (
              <DocumentBody item={item} content={content} />
            ) : (
              panel
            )}
          </div>
        </>
      ) : (
        <div className={styles.readerEmpty}>
          <DocumentIcon />
          <h2>문서를 선택해 주세요</h2>
          <p>왼쪽에서 자료를 선택하면 현재 확인할 수 있는 정보를 표시합니다.</p>
        </div>
      )}
    </section>
  );
}
