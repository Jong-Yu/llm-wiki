import { Button } from '@renderer/shared/ui/Button';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ChangeEvent, SubmitEvent, MouseEvent, JSX } from 'react';
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
import { useDocumentTrash } from '../model/useDocumentTrash';
import { DocumentTrash } from './DocumentTrash';
import styles from './DocumentLibrary.module.scss';

type DocumentLibraryProps = {
  onOpenDocument: (document: string) => void;
  onOpenOntology: (document: string) => void;
  onOpenSource: (sourceId: string, sourceVersion: string) => void;
  /** 이미 등록된 원본의 분석 시작입니다. 다른 feature의 후처리를 페이지가 연결합니다. */
  analysisStarter: SourceAnalysisStarter;
};
type StateFilter = ExtractionState | 'all' | 'running' | 'attention';

const statusLabels: Record<ExtractionState, string> = {
  ready: '등록 완료',
  stale: '온톨로지 갱신 필요',
  missing: '온톨로지 구성 필요',
  unknown: '확인 불가',
};
const filters: { value: StateFilter; label: string }[] = [
  { value: 'all', label: '전체 문서' },
  { value: 'running', label: '진행 중' },
  { value: 'attention', label: '확인 필요' },
  { value: 'ready', label: '등록 완료' },
  { value: 'stale', label: '관계 재추출 필요' },
  { value: 'missing', label: '관계 미추출' },
];

const sourceAnalysisLabels: Record<SourceAnalysisView['kind'], string> = {
  none: '등록 대기',
  unknown: '상태 확인 중',
  pending: 'Wiki 생성 대기',
  running: '분석 중',
  complete: '등록 완료',
  attention: '실패 확인 필요',
};

/** 로딩과 조회 결과가 같은 열 너비와 제목을 사용합니다. */
function DocumentTableHeader(): JSX.Element {
  return (
    <thead>
      <tr>
        <th>문서 이름</th>
        <th>상태</th>
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
  onOpenSource,
  analysisStarter,
}: DocumentLibraryProps): JSX.Element {
  const library = useDocumentLibrary();
  const active = useWorkspaceActivity();
  const [query, setQuery] = useState(libraryNavigation.query);
  const [filter, setFilter] = useState<string>(libraryNavigation.filter);
  const input = useRef<HTMLInputElement>(null);
  const lastOpened = useRef<HTMLElement | null>(null);
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
    }
  }, [library.state, active]);
  /** 목록으로 복귀할 때 검색·필터와 선택 위치를 함께 복원합니다. */
  function openDocument(path: string): void {
    rememberLibraryNavigation(query, filter, path);
    onOpenDocument(path);
  }
  const ready = library.state.status === 'ready' ? library.state.result : null;
  const trash = useDocumentTrash(ready?.scope ?? null, library.refresh);
  const rows = ready?.rows ?? [];
  const aiRequired = useAiConnection().status === 'required';
  const sourceItems = rows.flatMap((row: LibraryRow): LibrarySourceItem[] =>
    row.item.kind === 'source' ? [row.item] : [],
  );
  const analysis = useSourceAnalysis(
    ready?.scope ?? null,
    sourceItems,
    analysisStarter,
  );
  /** 원본 처리와 현재 Wiki의 상태를 하나로 보여 주되 다른 PC의 미조회 상태는 단정하지 않습니다. */
  function rowStatus(row: LibraryRow): {
    label: string;
    state: string;
    path: string;
  } {
    const item = row.item;
    if (item.kind === 'wiki')
      return {
        label: statusLabels[row.extraction],
        state: row.extraction,
        path: `/ontology?${new URLSearchParams({ path: item.document })}`,
      };
    const view = analysis.viewOf(item);
    const path =
      view.progressPath ??
      (view.jobId
        ? `/documents?${new URLSearchParams({ jobId: view.jobId })}`
        : `/source?${new URLSearchParams({ sourceId: item.sourceId, version: item.sourceVersion })}`);
    if (
      (item.linkedDocuments?.length ?? 0) > 0 &&
      (view.kind === 'none' || view.kind === 'complete')
    )
      return {
        label: statusLabels[row.extraction],
        state: row.extraction,
        path,
      };
    return {
      label: view.label ?? sourceAnalysisLabels[view.kind],
      state: view.kind,
      path,
    };
  }
  const visible = rows.filter((row: LibraryRow): boolean => {
    if (filter === 'all') return true;
    const state = rowStatus(row).state;
    if (filter === 'running') return state === 'running' || state === 'pending';
    if (filter === 'attention')
      return ['attention', 'unknown', 'stale', 'missing'].includes(state);
    return filter === 'ready'
      ? state === 'ready' || state === 'complete'
      : state === filter;
  });
  /** 클릭한 실제 제어의 초점만 복원하며 보존된 목록 스크롤을 움직이지 않습니다. */
  function rememberControl(event: MouseEvent<HTMLElement>, key: string): void {
    lastOpened.current = event.currentTarget;
    rememberLibraryNavigation(query, filter, key);
  }
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
      <div className={styles.refreshStatus} role="status" aria-live="polite">
        {library.refreshing ? '문서 목록을 갱신하고 있습니다.' : ''}
      </div>
      {library.refreshError && <p role="alert">{library.refreshError}</p>}
      <HeaderActions>
        {ready && (
          <Button
            variant="surface"
            aria-expanded={trash.open}
            onClick={(): void => trash.setOpen(!trash.open)}
          >
            <Icon name="trash-2" /> 휴지통
          </Button>
        )}
        <Link className={styles.primary} to="/register">
          <Icon name="plus" /> 문서 등록
        </Link>
      </HeaderActions>
      <DocumentTrash model={trash} />
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
                <p>
                  {ready.skipped.length}개 문서를 읽지 못했습니다. 다시 조회해
                  주세요.
                </p>
              )}
            </div>
          )}
          {library.request.query && (
            <div className={styles.resultLine} aria-live="polite">
              <span>“{library.request.query}” 검색 결과</span>
              <span>문서 {rows.length}개</span>
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
                    const key =
                      item.kind === 'wiki'
                        ? item.document
                        : `${item.sourceId}:${item.sourceVersion}`;
                    const status = rowStatus(row);
                    const linked =
                      item.kind === 'source'
                        ? (item.linkedDocuments ?? [])
                        : [];
                    const open = (): void => {
                      if (item.kind === 'wiki') openDocument(item.document);
                      else if (linked.length === 1)
                        onOpenDocument(linked[0].document);
                      else onOpenSource(item.sourceId, item.sourceVersion);
                    };
                    return (
                      <tr
                        data-selected={key === libraryNavigation.selected}
                        data-secondary="true"
                        key={key}
                      >
                        <td data-label="문서 이름">
                          <div className={styles.document}>
                            <span className={styles.fileIcon}>
                              <Icon name="file-text" />
                            </span>
                            <div>
                              <button
                                className={styles.title}
                                onClick={(
                                  event: MouseEvent<HTMLButtonElement>,
                                ): void => {
                                  rememberControl(event, key);
                                  open();
                                }}
                              >
                                {title}
                              </button>
                              <small>
                                {item.kind === 'source'
                                  ? item.format.toUpperCase()
                                  : item.document.split('/').at(-1)}
                                {linked.length > 1
                                  ? ` · Wiki ${linked.length}개`
                                  : ''}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td data-label="상태">
                          <Link
                            className={styles.badge}
                            data-state={status.state}
                            to={status.path}
                            state={{ workflowReturnTo: '/documents' }}
                            aria-label={`${title} · ${status.label} · 진행 상세`}
                            onClick={(
                              event: MouseEvent<HTMLAnchorElement>,
                            ): void => rememberControl(event, key)}
                          >
                            {status.state === 'running' && (
                              <Icon
                                name="loader-circle"
                                size={12}
                                className={styles.spin}
                              />
                            )}
                            {status.label}
                            <Icon name="chevron-right" size={12} />
                          </Link>
                        </td>
                        <td data-label="행동" className={styles.actionColumn}>
                          <div className={styles.rowActions}>
                            <button
                              className={styles.textButton}
                              onClick={(
                                event: MouseEvent<HTMLButtonElement>,
                              ): void => {
                                rememberControl(event, key);
                                open();
                              }}
                            >
                              {item.kind === 'wiki' || linked.length === 1
                                ? '문서 열기'
                                : linked.length > 1
                                  ? '문서 보기'
                                  : '원본 보기'}
                            </button>
                            <button
                              type="button"
                              className={styles.textButton}
                              disabled={trash.busy}
                              aria-label={`${title} 삭제`}
                              onClick={(): void => trash.choose(item)}
                            >
                              <Icon name="trash-2" size={16} />
                            </button>
                          </div>
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
