import { useId, useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { documentDisplayName } from '@renderer/domains/documents';
import { useReadQueries } from '@renderer/shared/lib/readQueries';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { Icon } from '@renderer/shared/ui/Icon';
import {
  cachedLibraryDocument,
  librarySourceReference,
  readLibraryDocumentInfo,
} from '../api/documentLibrary.queries';
import type { LibraryDocumentInfo } from '../api/documentLibrary.queries';
import type { LibraryRow, LibraryScope } from '../model/documentLibrary.types';
import type { DocumentListItem } from '@contracts/documents.contract';
import styles from './DocumentLibrary.module.scss';

type WikiDocumentIdentityProps = {
  item: Extract<DocumentListItem, { kind: 'wiki' }>;
  scope: LibraryScope;
  snippet: LibraryRow['snippet'];
  author: string;
  onOpen: (document: string) => void;
};

/** 위키 파일과 등록 원본을 구분하고 선택한 행에서만 상세 식별 정보를 확인합니다. */
export function WikiDocumentIdentity({
  item,
  scope,
  snippet,
  author,
  onOpen,
}: WikiDocumentIdentityProps): JSX.Element {
  const { cache, snapshot } = useReadQueries();
  const active = useWorkspaceActivity();
  const infoId = useId();
  const [expanded, setExpanded] = useState(false);
  const known = cachedLibraryDocument(cache, item, scope);
  const info = useQuery({
    queryKey: cache.key('document-library-info', item.document, item.revision),
    enabled: expanded && active && !snapshot.failure,
    queryFn: (): Promise<LibraryDocumentInfo> =>
      readLibraryDocumentInfo(item, scope, known),
  });
  const metadata = info.data?.metadata ?? known?.metadata ?? item.metadata;
  const source = info.data?.source ?? librarySourceReference(metadata);
  const title = documentDisplayName(
    item.document,
    typeof metadata?.title === 'string' ? metadata.title : undefined,
  );
  const filename = documentDisplayName(item.document);
  const originalPath = source
    ? `/source?${new URLSearchParams({ sourceId: source.id, version: source.version })}`
    : null;
  return (
    <div>
      <small>
        위키 문서{source ? ' · 원본에서 만든 문서' : ''}
        {author ? ` · ${author}` : ''}
      </small>
      <button
        className={styles.title}
        onClick={(): void => onOpen(item.document)}
      >
        {title}
      </button>
      {filename !== '제목 없는 문서' && <small>파일명: {filename}.md</small>}
      {snippet && <p>{snippet}</p>}
      <div className={styles.identityActions}>
        <button
          className={styles.textButton}
          aria-label={`${title} 문서 정보`}
          aria-expanded={expanded}
          aria-controls={infoId}
          onClick={(): void => setExpanded(!expanded)}
        >
          문서 정보
          <Icon name="chevron-down" size={12} data-open={expanded} />
        </button>
        {originalPath && (
          <Link className={styles.textButton} to={originalPath}>
            {source?.title
              ? `원본: ${documentDisplayName(source.title)}`
              : '원본 보기'}
          </Link>
        )}
      </div>
      {expanded && (
        <div
          className={styles.documentInfo}
          id={infoId}
          role="region"
          aria-label={`${title} 문서 식별 정보`}
        >
          {info.isPending && (
            <p role="status">문서 정보를 확인하고 있습니다.</p>
          )}
          {info.error && (
            <p role="alert">
              {info.error.message}
              <button
                className={styles.textButton}
                onClick={(): void => {
                  void info.refetch();
                }}
              >
                다시 확인
              </button>
            </p>
          )}
          {info.data && (
            <>
              <dl>
                <div>
                  <dt>문서 제목</dt>
                  <dd>{title}</dd>
                </div>
                <div>
                  <dt>등록 원본</dt>
                  <dd>
                    {source
                      ? source.title
                        ? documentDisplayName(source.title)
                        : '연결된 원본 있음'
                      : '연결 없음'}
                  </dd>
                </div>
              </dl>
              {info.data.sourceMessage && <p>{info.data.sourceMessage}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
