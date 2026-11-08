import { Button } from '@renderer/shared/ui/Button';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ChangeEvent, SubmitEvent, JSX } from 'react';
import { Link } from 'react-router';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import {
  useDocumentLibrary,
  libraryNavigation,
  rememberLibraryNavigation,
} from '../model/useDocumentLibrary';
import { useSourceAnalysis } from '../model/useSourceAnalysis';
import type { SourceAnalysisView } from '../model/useSourceAnalysis';
import type {
  ExtractionState,
  LibraryRow,
  LibrarySourceItem,
  SourceAnalysisStarter,
} from '../model/documentLibrary.types';
import { SkeletonBar, SkeletonList } from '@renderer/shared/ui/Skeleton';
import { WikiDocumentIdentity } from './WikiDocumentIdentity';
import styles from './DocumentLibrary.module.scss';

type DocumentLibraryProps = {
  onOpenDocument: (document: string) => void;
  onOpenOntology: (document: string) => void;
  onOpenSource: (sourceId: string, sourceVersion: string) => void;
  /** 이미 등록된 원본의 분석 시작입니다. 다른 feature의 후처리를 페이지가 연결합니다. */
  analysisStarter: SourceAnalysisStarter;
};
type StateFilter = ExtractionState | 'all';

/** 읽지 못한 문서는 대상 이름과 확인 가능한 실패 이유로 구별합니다. */
function skippedDocumentReason(code: string): string {
  switch (code) {
    case 'not_found':
      return '문서를 찾을 수 없습니다';
    case 'permission_denied':
      return '읽기 권한이 없습니다';
    case 'document_too_large':
      return '조회 가능한 크기를 넘었습니다';
    case 'invalid_utf8':
      return '문자 형식을 읽을 수 없습니다';
    default:
      return '문서를 읽지 못했습니다';
  }
}
const statusLabels: Record<ExtractionState, string> = {
  ready: '관계 추출 완료',
  stale: '관계 재추출 필요',
  missing: '관계 미추출',
  unknown: '확인 불가',
};
const filters: { value: StateFilter; label: string }[] = [
  { value: 'all', label: '전체 문서' },
  { value: 'ready', label: '관계 추출 완료' },
  { value: 'stale', label: '관계 재추출 필요' },
  { value: 'missing', label: '관계 미추출' },
];

const sourceAnalysisLabels: Record<SourceAnalysisView['kind'], string> = {
  none: '분석 전',
  unknown: '상태 확인 중',
  pending: '분석 대기',
  running: '분석 중',
  complete: '분석 완료',
  attention: '실패 확인 필요',
};

/** 서버 원장에 기록된 생성 경로만 작성자 종류로 표시합니다. */
function authorLabel(row: LibraryRow): string {
  if (row.item.kind !== 'wiki') return '';
  const record = row.item.authorship;
  if (record?.status !== 'recorded')
    return record?.status === 'pending_reconcile' ? '작성 이력 확인 중' : '';
  const origin = record.updated?.origin;
  const kind =
    typeof origin === 'string'
      ? origin
      : origin && typeof origin === 'object' && !Array.isArray(origin)
        ? origin.kind
        : null;
  return kind === 'ai' ? 'AI 작성' : kind === 'human' ? '사람 수정' : '';
}

/** 로딩과 조회 결과가 같은 열 너비와 제목을 사용합니다. */
function DocumentTableHeader(): JSX.Element {
  return (
    <thead>
      <tr>
        <th>문서 이름</th>
        <th>상태</th>
        <th className={styles.numeric}>관계</th>
        <th className={styles.actionColumn}>
          <span className={styles.srOnly}>행동</span>
        </th>
      </tr>
    </thead>
  );
}

/** 실제 목록·검색과 지식 상태를 조합하고 입력·실패·빈 결과를 구분합니다. */
export function DocumentLibrary({
  onOpenDocument,
  onOpenOntology,
  onOpenSource,
  analysisStarter,
}: DocumentLibraryProps): JSX.Element {
  const library = useDocumentLibrary();
  const active = useWorkspaceActivity();
  const [query, setQuery] = useState(libraryNavigation.query);
  const [filter, setFilter] = useState<string>(libraryNavigation.filter);
  const input = useRef<HTMLInputElement>(null);
  const lastOpened = useRef<HTMLTableRowElement>(null);
  const restorePosition = useRef(false);
  const wasActive = useRef(active);
  const refreshOnReturn = useEffectEvent((): void => {
    restorePosition.current = true;
    library.revalidate();
  });
  useEffect((): void => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (returned) refreshOnReturn();
  }, [active]);
  useEffect((): void => {
    if (
      active &&
      library.state.status === 'ready' &&
      restorePosition.current &&
      lastOpened.current
    ) {
      restorePosition.current = false;
      lastOpened.current.focus({ preventScroll: true });
      lastOpened.current.scrollIntoView({ block: 'center' });
    }
  }, [library.state, active]);
  /** 목록으로 복귀할 때 검색·필터와 선택 위치를 함께 복원합니다. */
  function openDocument(path: string): void {
    rememberLibraryNavigation(query, filter, path);
    onOpenDocument(path);
  }
  const ready = library.state.status === 'ready' ? library.state.result : null;
  const rows = ready?.rows ?? [];
  const aiRequired = useAiConnection().status === 'required';
  const sourceItems = rows.flatMap((row: LibraryRow): LibrarySourceItem[] =>
    row.item.kind === 'source' ? [row.item] : [],
  );
  const analysis = useSourceAnalysis(
    ready?.scope.connectionId ?? null,
    sourceItems,
    analysisStarter,
  );
  const visible = rows.filter(
    (row: LibraryRow): boolean =>
      filter === 'all' ||
      (row.item.kind === 'wiki' && row.extraction === filter),
  );
  const isEmpty =
    ready &&
    rows.length === 0 &&
    !library.request.query &&
    !library.request.cursor &&
    !ready.incomplete;

  /** 검색 입력과 상태 필터를 함께 초기화하고 검색 입력으로 포커스를 돌립니다. */
  function reset(): void {
    setQuery('');
    setFilter('all');
    library.search('');
    input.current?.focus();
  }
  /** 서버 검색은 사용자가 제출한 문자열만 요청하며 작성 중인 다음 검색어를 덮지 않습니다. */
  function search(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    library.search(query);
  }

  return (
    <section className={styles.library} aria-label="문서 보관함">
      {aiRequired && sourceItems.length > 0 && (
        <ConnectionNotice
          kind="ai-required"
          action={
            <Link className={styles.primary} to="/settings?section=ai">
              AI 연결하기
            </Link>
          }
        />
      )}
      {analysis.message && <p role="alert">{analysis.message}</p>}
      {library.refreshing && (
        <p role="status">문서 목록을 갱신하고 있습니다.</p>
      )}
      {library.refreshError && <p role="alert">{library.refreshError}</p>}
      <HeaderActions>
        <Link className={styles.primary} to="/register">
          <Icon name="plus" /> 문서 등록
        </Link>
      </HeaderActions>
      {!isEmpty && library.state.status !== 'unselected' && (
        <section className={styles.finder} aria-label="문서 찾기">
          <div className={styles.toolbar}>
            <form className={styles.search} onSubmit={search} role="search">
              <label className={styles.searchInput}>
                <Icon name="search" />
                <input
                  ref={input}
                  aria-label="문서 검색"
                  placeholder="문서 이름이나 내용으로 검색 (Enter)"
                  value={query}
                  maxLength={200}
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    setQuery(event.target.value)
                  }
                />
              </label>
            </form>
            <div className={styles.tools}>
              <label>
                <span className={styles.srOnly}>문서 상태 필터</span>
                <select
                  aria-label="문서 상태 필터"
                  value={filter}
                  onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                    setFilter(event.target.value)
                  }
                >
                  {filters.map(
                    (option: {
                      value: StateFilter;
                      label: string;
                    }): JSX.Element => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
          </div>
        </section>
      )}
      {library.state.status === 'loading' && (
        <SkeletonList
          label="문서를 불러오는 중"
          className={styles.skeletonList}
        >
          <div className={styles.tableWrap} aria-hidden="true">
            <table className={styles.table}>
              <DocumentTableHeader />
              <tbody>
                {[0, 1, 2, 3, 4].map((index: number): JSX.Element => (
                  <tr key={index} data-secondary="true">
                    <td data-label="문서 이름">
                      <div className={styles.document}>
                        <span className={styles.fileIcon}>
                          <SkeletonBar shape="icon" />
                        </span>
                        <div className={styles.skeletonText}>
                          <SkeletonBar shape="title" />
                          <SkeletonBar shape="sub" />
                        </div>
                      </div>
                    </td>
                    <td data-label="상태">
                      <SkeletonBar shape="badge" />
                    </td>
                    <td data-label="관계" className={styles.numeric}>
                      <SkeletonBar
                        shape="icon"
                        className={styles.skeletonNumeric}
                      />
                    </td>
                    <td data-label="행동" className={styles.actionColumn}>
                      <SkeletonBar
                        shape="badge"
                        className={styles.skeletonNumeric}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SkeletonList>
      )}
      {library.state.status === 'unselected' && (
        <div className={styles.state}>
          <span className={styles.symbol} aria-hidden="true">
            <Icon name="settings" size={24} />
          </span>
          <h2>작업 공간을 먼저 선택해 주세요</h2>
          <p>작업 공간을 선택하면 문서 목록이 표시됩니다.</p>
          <Link className={styles.primary} to="/settings">
            연결하기
          </Link>
        </div>
      )}
      {library.state.status === 'error' && (
        <div className={`${styles.state} ${styles.error}`} role="alert">
          <span className={styles.symbol} aria-hidden="true">
            <Icon name="triangle-alert" size={24} />
          </span>
          <h2>문서 목록을 불러오지 못했습니다</h2>
          <p>{library.state.message}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              type="submit"
              className={styles.primary}
              onClick={library.refresh}
            >
              다시 불러오기
            </Button>
            <Link className={styles.button} to="/settings">
              연결하기
            </Link>
          </div>
        </div>
      )}
      {isEmpty && (
        <div className={styles.state}>
          <span className={styles.symbol} aria-hidden="true">
            <Icon name="file-text" size={24} />
          </span>
          <h2>첫 문서를 등록해 보세요</h2>
          <p>파일을 선택하거나 텍스트를 붙여넣으세요.</p>
          <Link className={styles.primary} to="/register">
            문서 등록
          </Link>
        </div>
      )}
      {ready && !isEmpty && (
        <>
          {ready.incomplete && (
            <div className={styles.notice} role="status">
              <strong>일부 결과만 확인했습니다</strong>
              <p>
                조회 한도 또는 읽기 실패로 전체 문서가 표시되지 않을 수
                있습니다.
              </p>
              {ready.skipped.length > 0 && (
                <details>
                  <summary>읽지 못한 문서 {ready.skipped.length}개</summary>
                  <ul>
                    {ready.skipped.map(
                      (item: {
                        document: string;
                        code: string;
                      }): JSX.Element => (
                        <li key={`${item.document}:${item.code}`}>
                          {documentDisplayName(item.document)} ·{' '}
                          {skippedDocumentReason(item.code)}
                        </li>
                      ),
                    )}
                  </ul>
                </details>
              )}
            </div>
          )}
          {library.request.query && (
            <div className={styles.resultLine} aria-live="polite">
              <span>“{library.request.query}” 검색 결과</span>
              <span>
                등록 원본 {sourceItems.length}개 · 위키 문서{' '}
                {rows.length - sourceItems.length}개
              </span>
            </div>
          )}
          {visible.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>문서 목록</caption>
                <DocumentTableHeader />
                <tbody>
                  {visible.map((row: LibraryRow): JSX.Element => {
                    const item = row.item;
                    const title =
                      item.kind === 'wiki'
                        ? documentDisplayName(
                            item.document,
                            typeof item.metadata?.title === 'string'
                              ? item.metadata.title
                              : undefined,
                          )
                        : documentDisplayName(item.title);
                    return (
                      <tr
                        ref={
                          item.kind === 'wiki' &&
                          item.document === libraryNavigation.selected
                            ? lastOpened
                            : undefined
                        }
                        tabIndex={
                          item.kind === 'wiki' &&
                          item.document === libraryNavigation.selected
                            ? -1
                            : undefined
                        }
                        data-selected={
                          item.kind === 'wiki' &&
                          item.document === libraryNavigation.selected
                        }
                        data-secondary={
                          !!(
                            item.kind === 'wiki' ||
                            authorLabel(row) ||
                            row.snippet ||
                            item.kind === 'source' ||
                            row.extractionMessage
                          )
                        }
                        key={
                          item.kind === 'wiki'
                            ? item.document
                            : `${item.sourceId}:${item.sourceVersion}`
                        }
                      >
                        <td data-label="문서 이름">
                          <div className={styles.document}>
                            <span className={styles.fileIcon}>
                              <Icon name="file-text" />
                            </span>
                            {item.kind === 'wiki' ? (
                              <WikiDocumentIdentity
                                item={item}
                                scope={ready.scope}
                                snippet={row.snippet}
                                author={authorLabel(row)}
                                onOpen={openDocument}
                              />
                            ) : (
                              <div>
                                <small>등록 원본</small>
                                <button
                                  className={styles.title}
                                  onClick={(): void =>
                                    onOpenSource(
                                      item.sourceId,
                                      item.sourceVersion,
                                    )
                                  }
                                >
                                  {title}
                                </button>
                                <p>
                                  {item.format.toUpperCase()} ·{' '}
                                  {item.sizeBytes < 1024
                                    ? `${item.sizeBytes.toLocaleString('ko-KR')} B`
                                    : `${(item.sizeBytes / 1024).toFixed(1)} KB`}
                                </p>
                                {item.linkedDocumentCount > 0 && (
                                  <small>
                                    생성된 위키 문서 {item.linkedDocumentCount}
                                    개
                                  </small>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                        <td data-label="상태">
                          <span
                            className={styles.badge}
                            data-state={
                              item.kind === 'source'
                                ? analysis.viewOf(item).kind === 'unknown'
                                  ? 'source'
                                  : analysis.viewOf(item).kind
                                : row.extraction
                            }
                          >
                            {item.kind === 'source'
                              ? sourceAnalysisLabels[analysis.viewOf(item).kind]
                              : statusLabels[row.extraction]}
                          </span>
                          {row.extractionMessage &&
                            row.item.kind === 'wiki' && (
                              <p className={styles.rowHint}>
                                {row.extractionMessage}
                              </p>
                            )}
                        </td>
                        <td data-label="관계" className={styles.numeric}>
                          {row.relationCount !== null &&
                          item.kind === 'wiki' ? (
                            <button
                              className={styles.textButton}
                              onClick={(): void =>
                                onOpenOntology(item.document)
                              }
                            >
                              {row.relationCount}개
                            </button>
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                        <td data-label="행동" className={styles.actionColumn}>
                          {item.kind === 'source' &&
                            ((): JSX.Element | null => {
                              const view = analysis.viewOf(item);
                              if (view.kind === 'none')
                                return (
                                  <button
                                    className={styles.textButton}
                                    disabled={aiRequired}
                                    onClick={(): void => {
                                      void analysis.start(item);
                                    }}
                                  >
                                    분석 시작
                                  </button>
                                );
                              return view.jobId ? (
                                <Link
                                  className={styles.textButton}
                                  to={`/jobs?jobId=${encodeURIComponent(view.jobId)}`}
                                >
                                  작업 보기
                                </Link>
                              ) : null;
                            })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.state}>
              <span className={styles.symbol} aria-hidden="true">
                <Icon name="search" size={24} />
              </span>
              <h2>
                {ready.incomplete
                  ? '현재 확인한 범위에 결과가 없습니다'
                  : '검색 결과가 없습니다'}
              </h2>
              <p>
                {library.request.query
                  ? `“${library.request.query}”와 현재 필터에 일치하는 문서를 찾지 못했습니다.`
                  : '현재 페이지에서 선택한 조건에 맞는 문서가 없습니다.'}
              </p>
              <p>검색어를 바꾸거나 필터를 초기화해 주세요.</p>
              <Button
                variant="surface"
                type="submit"
                className={styles.button}
                onClick={reset}
              >
                검색 조건 초기화
              </Button>
            </div>
          )}
          {!library.request.query && (
            <nav className={styles.pagination} aria-label="문서 페이지">
              <Button
                variant="surface"
                type="submit"
                className={`${styles.button} ${styles.pageButton}`}
                aria-label="이전 페이지"
                disabled={library.request.previousCursors.length === 0}
                onClick={library.previous}
              >
                <Icon name="chevron-right" className={styles.flipIcon} />
              </Button>
              <b aria-current="page">
                {library.request.previousCursors.length + 1}
              </b>
              <Button
                variant="surface"
                type="submit"
                className={`${styles.button} ${styles.pageButton}`}
                aria-label="다음 페이지"
                disabled={!ready.nextCursor}
                onClick={library.next}
              >
                <Icon name="chevron-right" />
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
