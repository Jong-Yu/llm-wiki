import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { SourceRegistrationRecord } from '@contracts/sources.contract';
import type { SourceExpectedScope } from '@contracts/sources.contract';
import type {
  DocumentContent,
  SourcePreviewRequest,
} from '@contracts/documents.contract';
import type { DocumentListScope } from '../api/documentList.api';
import { Link } from 'react-router';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useDocumentList } from '../model/useDocumentList';
import { useDocumentPreview } from '../model/useDocumentPreview';
import type { DocumentPreviewState } from '../model/useDocumentPreview';
import { DocumentIcon } from './DocumentIcon';
import { DocumentReader } from './DocumentReader';
import type {
  DocumentListItem,
  DocumentListModel,
  DocumentListState,
} from '../model/useDocumentList';
import {
  catalogFiltersSchema,
  createCatalogFilters,
  catalogFolders,
  documentItemKey,
  documentItemTitle,
  filterCatalog,
  wikiFolder,
} from '../model/documentCatalog';
import type {
  CatalogFilters,
  DocumentPanelTab,
} from '../model/documentCatalog';
import styles from './ListDocuments.module.scss';

type DocumentRowProps = {
  item: DocumentListItem;
  selected: boolean;
  onSelect: (key: string) => void;
};
type DocumentSelectionProps = { item: DocumentListItem | null };
type DocumentContextProps = DocumentSelectionProps & {
  state: DocumentListState;
  content: DocumentPreviewState;
  onAnalyzeSource?: (selection: DocumentAnalysisSelection) => void;
};
type DocumentSelectionRegionProps = DocumentSelectionProps & {
  state: DocumentListState;
  onScopeInvalidated: () => void;
  onAnalyzeSource?: (selection: DocumentAnalysisSelection) => void;
  tab: DocumentPanelTab;
  onTabChange: (tab: DocumentPanelTab) => void;
  renderPanel?: (context: DocumentPanelContext) => ReactNode;
  onEditDocument?: (current: DocumentContent, onSaved: () => void) => void;
  onPreview: (reference: SourcePreviewRequest) => void;
  onOpenDocument: (document: string) => void;
  onUpdated: (
    record: Extract<SourceRegistrationRecord, { state: 'complete' }>,
  ) => void;
};
type DocumentWorkspaceProps = DocumentListModel & {
  onAnalyzeSource?: (selection: DocumentAnalysisSelection) => void;
  renderPanel?: (context: DocumentPanelContext) => ReactNode;
  onEditDocument?: (current: DocumentContent, onSaved: () => void) => void;
};
type CatalogStateProps = { state: DocumentListState };
/** 페이지에 원본 참조와 현재 범위만 전달합니다. 분석 feature를 목록 안에서 실행하지 않습니다. */
export type DocumentAnalysisSelection = {
  connectionId: string;
  sourceId: string;
  sourceVersion: string;
  sourceSha256: string;
  registrationRevision: string;
  title: string;
  scope: {
    userId: string;
    tenant: string;
    profileId: string;
    policyRevision: string;
  };
};
export type DocumentRegistrationContext = {
  connectionId: string | null;
  tenant: string | null;
  allowed: boolean;
  onRegistered: (
    record: Extract<SourceRegistrationRecord, { state: 'complete' }>,
  ) => void;
  onScopeInvalidated: () => void;
  expectedScope?: SourceExpectedScope;
};
export type DocumentPanelContext = {
  item: DocumentListItem;
  scope: DocumentListScope;
  tab: DocumentPanelTab;
  onScopeInvalidated: () => void;
  onPreview: (reference: SourcePreviewRequest) => void;
  onOpenDocument: (document: string) => void;
  onUpdated: (
    record: Extract<SourceRegistrationRecord, { state: 'complete' }>,
  ) => void;
};
type ListDocumentsProps = {
  navigation?: ReactNode;
  initialDocument?: string;
  renderRegistration?: (context: DocumentRegistrationContext) => ReactNode;
  onAnalyzeSource?: (selection: DocumentAnalysisSelection) => void;
  renderPanel?: (context: DocumentPanelContext) => ReactNode;
  onEditDocument?: (current: DocumentContent, onSaved: () => void) => void;
};

/** 한 줄 제목은 시각적으로 줄이되 같은 실제 자료의 전체 이름을 접근 이름에 보존합니다. */
function DocumentRow({
  item,
  selected,
  onSelect,
}: DocumentRowProps): JSX.Element {
  const title = documentItemTitle(item);
  const kind = item.kind === 'source' ? '등록 원본' : '위키';
  const status =
    item.kind === 'source'
      ? '원본 등록'
      : item.sourceStatus === 'unknown'
        ? '연결 기준 확인 전'
        : '원본 미연결';
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        aria-label={`${kind} · ${title} · ${status}`}
        aria-pressed={selected}
        title={title}
        onClick={(): void => onSelect(documentItemKey(item))}
      >
        <span className={styles.rowTitle}>
          <DocumentIcon />
          <span>{title}</span>
        </span>
        <span className={styles.rowMeta}>
          {kind}
          {item.kind === 'wiki'
            ? ` · ${wikiFolder(item.document) === '/' ? '루트' : wikiFolder(item.document)}`
            : ` · ${item.format.toUpperCase()}`}
        </span>
        <small>{status}</small>
      </button>
    </li>
  );
}

/** 목록의 실패와 부분 조회는 선택한 문서가 아닌 현재 API 결과로 표시합니다. */
function CatalogState({ state }: CatalogStateProps): JSX.Element | null {
  if (state.status === 'loading')
    return (
      <StatusNotice title="문서 목록을 불러오고 있습니다">
        현재 연결과 조회 범위를 확인하고 있습니다.
      </StatusNotice>
    );
  if (state.status === 'unselected')
    return (
      <StatusNotice title="작업 공간을 먼저 선택해 주세요">
        <Link className={styles.link} to="/setup/connection">
          서버 연결·작업 공간 선택
        </Link>
      </StatusNotice>
    );
  if (state.status === 'error') {
    const changed = [
      'catalog_changed',
      'invalid_cursor',
      'scope_changed',
    ].includes(state.error.code);
    return (
      <StatusNotice
        tone="error"
        title={
          changed
            ? '목록 기준이 변경되었습니다'
            : '문서 목록을 불러오지 못했습니다'
        }
      >
        <p>{state.error.message}</p>
        {changed && <p>새로고침을 눌러 첫 페이지부터 다시 확인해 주세요.</p>}
        {!state.scope && (
          <Link className={styles.link} to="/setup/connection">
            서버 연결·작업 공간 선택
          </Link>
        )}
        {state.error.traceId && (
          <p className={styles.trace}>문의 코드: {state.error.traceId}</p>
        )}
      </StatusNotice>
    );
  }
  const page = state.page;
  const incomplete =
    page.truncated ||
    page.requiresRefresh ||
    page.skipped.length > 0 ||
    (!page.complete && page.nextCursor === null);
  if (page.items.length === 0 && !incomplete && page.nextCursor === null)
    return (
      <StatusNotice title="문서가 없습니다">
        현재 조회 범위에 저장된 문서가 없습니다.
      </StatusNotice>
    );
  if (!incomplete) return null;
  return (
    <StatusNotice tone="warning" title="일부 조회 안내">
      <ul className={styles.warnings}>
        {!page.complete && (
          <li>선택 범위의 조회가 완전히 끝나지 않았습니다.</li>
        )}
        {page.truncated && (
          <li>
            서버의 조회 한도에 도달했습니다. 현재 결과를 전체 자료로 해석하지
            마세요.
          </li>
        )}
        {page.requiresRefresh && (
          <li>
            목록 기준을 다시 확인해야 합니다. 새로고침으로 첫 페이지부터 조회해
            주세요.
          </li>
        )}
        {page.skipped.length > 0 && (
          <li>
            읽지 못한 문서가 {page.skipped.length}개 있습니다.
            <details>
              <summary>읽지 못한 문서 확인</summary>
              <ul>
                {page.skipped.map(
                  (item: { document: string; code: string }): JSX.Element => (
                    <li key={`${item.document}:${item.code}`}>
                      {item.document} · {item.code}
                    </li>
                  ),
                )}
              </ul>
            </details>
          </li>
        )}
      </ul>
    </StatusNotice>
  );
}

/** 문서 정보와 확인 범위를 보존하고 긴 판본/해시는 별도 펼침 영역에 둡니다. */
function DocumentContextPanel({
  item,
  state,
  content,
  onAnalyzeSource,
}: DocumentContextProps): JSX.Element {
  return (
    <aside className={styles.context} aria-label="문서 정보">
      <section>
        <h2>문서 정보</h2>
        {item ? (
          <>
            <div className={styles.contextTitle}>
              <DocumentIcon />
              <strong>{documentItemTitle(item)}</strong>
            </div>
            <dl>
              <dt>자료 종류</dt>
              <dd>{item.kind === 'source' ? '등록 원본' : '위키'}</dd>
              <dt>현재 확인 상태</dt>
              <dd>
                {item.kind === 'source'
                  ? '원본 등록'
                  : item.sourceStatus === 'unknown'
                    ? '연결 기준 확인 전'
                    : '원본 미연결'}
              </dd>
              {item.kind === 'source' ? (
                <>
                  <dt>원본 ID</dt>
                  <dd>{item.sourceId}</dd>
                  <dt>파일 형식</dt>
                  <dd>{item.format.toUpperCase()}</dd>
                  <dt>파일 크기</dt>
                  <dd>
                    {new Intl.NumberFormat('ko-KR').format(item.sizeBytes)} B
                  </dd>
                  <dt>연결된 위키</dt>
                  <dd>{item.linkedDocumentCount}개</dd>
                </>
              ) : (
                <>
                  <dt>문서 경로</dt>
                  <dd>{item.document}</dd>
                  <dt>폴더</dt>
                  <dd>
                    {wikiFolder(item.document) === '/'
                      ? '루트'
                      : wikiFolder(item.document)}
                  </dd>
                </>
              )}
            </dl>
            {item.kind === 'source' &&
            (item.format === 'md' || item.format === 'txt') &&
            state.status === 'ready' &&
            onAnalyzeSource ? (
              <Button
                variant="secondary"
                onClick={(): void =>
                  onAnalyzeSource({
                    connectionId: state.scope.connectionId,
                    sourceId: item.sourceId,
                    sourceVersion: item.sourceVersion,
                    sourceSha256: item.sourceSha256,
                    registrationRevision: item.registrationRevision,
                    title: item.title,
                    scope: {
                      userId: state.scope.userId,
                      tenant: state.scope.tenant,
                      profileId: state.scope.profileId,
                      policyRevision: state.scope.policyRevision,
                    },
                  })
                }
              >
                분석·결과
              </Button>
            ) : null}
            <p>
              <Link
                to={
                  item.kind === 'source'
                    ? `/analysis-plan?sourceId=${encodeURIComponent(item.sourceId)}&sourceVersion=${encodeURIComponent(item.sourceVersion)}`
                    : `/analysis-plan?document=${encodeURIComponent(item.document)}`
                }
              >
                분석 범위·산출물 설정
              </Link>
            </p>
            <details className={styles.revisions}>
              <summary>판본 정보</summary>
              <dl>
                {item.kind === 'source' ? (
                  <>
                    <dt>원본 판본</dt>
                    <dd>{item.sourceVersion}</dd>
                    <dt>원본 SHA-256</dt>
                    <dd>{item.sourceSha256}</dd>
                    <dt>등록 판본</dt>
                    <dd>{item.registrationRevision}</dd>
                  </>
                ) : (
                  <>
                    <dt>목록 판본</dt>
                    <dd>{item.revision}</dd>
                    {content.status === 'ready' &&
                      'revision' in content.content && (
                        <>
                          <dt>읽은 본문 판본</dt>
                          <dd>{content.content.revision}</dd>
                        </>
                      )}
                  </>
                )}
              </dl>
            </details>
          </>
        ) : (
          <p className={styles.caption}>
            자료를 선택하면 문서 종류와 현재 확인 상태가 표시됩니다.
          </p>
        )}
      </section>
      {state.status === 'ready' && (
        <section>
          <h3>현재 조회 범위</h3>
          <dl>
            <dt>서버</dt>
            <dd>{state.scope.serverUrl}</dd>
            <dt>사용자</dt>
            <dd>{state.scope.userId}</dd>
            <dt>작업 공간</dt>
            <dd>{state.scope.tenant}</dd>
            <dt>관점</dt>
            <dd>{state.scope.profileId}</dd>
          </dl>
          <p className={styles.caption}>현재 페이지의 자료 정보입니다.</p>
        </section>
      )}
    </aside>
  );
}

/** 선택 키별 본문 수명을 분리하며 실제 읽은 판본을 정보 패널과 함께 표시합니다. */
function DocumentSelectionRegion({
  item,
  state,
  onScopeInvalidated,
  onAnalyzeSource,
  tab,
  onTabChange,
  renderPanel,
  onEditDocument,
  onPreview,
  onOpenDocument,
  onUpdated,
}: DocumentSelectionRegionProps): JSX.Element {
  const content = useDocumentPreview({
    item: tab === 'body' ? item : null,
    scope: state.status === 'ready' ? state.scope : null,
    onScopeInvalidated,
  });
  const editable =
    content.state.status === 'ready' && 'document' in content.state.content
      ? content.state.content
      : null;
  /** 편집은 실제 읽은 본문/revision만 넘기고 저장 뒤 해당 문서를 다시 읽습니다. */
  function editCurrent(): void {
    if (editable && onEditDocument)
      onEditDocument(editable, (): void => onOpenDocument(editable.document));
  }
  return (
    <>
      <WorkspacePane name="content">
        <DocumentReader
          item={item}
          content={content}
          tab={tab}
          onTabChange={onTabChange}
          onEdit={
            state.status === 'ready' &&
            state.scope.canEditWiki &&
            editable &&
            onEditDocument
              ? editCurrent
              : undefined
          }
          panel={
            item && state.status === 'ready' && tab !== 'body'
              ? renderPanel?.({
                  item,
                  scope: state.scope,
                  tab,
                  onScopeInvalidated,
                  onPreview,
                  onOpenDocument,
                  onUpdated,
                })
              : undefined
          }
        />
      </WorkspacePane>
      <WorkspacePane name="inspector">
        <DocumentContextPanel
          item={item}
          state={state}
          content={content.state}
          onAnalyzeSource={onAnalyzeSource}
        />
      </WorkspacePane>
    </>
  );
}

/** 한 페이지의 필터/선택을 소유하며 필터 변경 자체를 명시적인 선택 해제로 처리합니다. */
function DocumentWorkspace({
  state,
  previous,
  next,
  refresh,
  onAnalyzeSource,
  renderPanel,
  onEditDocument,
  openDocument,
  showRegisteredSource,
}: DocumentWorkspaceProps): JSX.Element {
  const ready = state.status === 'ready' ? state : null;
  const pageItems = ready ? ready.page.items : [];
  const registered = ready?.linkedDocument ?? ready?.registeredSource;
  const pinned =
    registered &&
    !pageItems.some(
      (item: DocumentListItem): boolean =>
        documentItemKey(item) === documentItemKey(registered),
    )
      ? registered
      : null;
  const items = pinned ? [pinned, ...pageItems] : pageItems;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    registered ? documentItemKey(registered) : null,
  );
  const [tab, setTab] = useState<DocumentPanelTab>('body');
  const [previewOverride, setPreviewOverride] =
    useState<DocumentListItem | null>(null);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CatalogFilters, unknown>({
    resolver: zodResolver(catalogFiltersSchema),
    defaultValues: createCatalogFilters(),
    mode: 'onChange',
  });
  const query = useWatch({ control, name: 'query' });
  const folder = useWatch({ control, name: 'folder' });
  const kind = useWatch({ control, name: 'kind' });
  const visible = filterCatalog(items, { query, folder, kind });
  const folders = catalogFolders(items);
  const selected = ready
    ? visible.find(
        (item: DocumentListItem): boolean =>
          documentItemKey(item) === selectedKey,
      )
    : undefined;
  const currentItem =
    previewOverride ?? (selected === undefined ? null : selected);
  const sources = visible.filter(
    (item: DocumentListItem): boolean => item.kind === 'source',
  );
  const wikis = visible.filter(
    (item: DocumentListItem): boolean => item.kind === 'wiki',
  );

  /** 필터를 바꾸면 이전 선택을 즉시 해제합니다. */
  function clearSelection(): void {
    setSelectedKey(null);
    setPreviewOverride(null);
    setTab('body');
  }
  /** Enter 제출은 현재 페이지 조건에만 적용합니다. */
  function applyFilters(_values: CatalogFilters): void {
    clearSelection();
  }
  /** 현재 목록에 있는 자료의 표시 키만 보관합니다. */
  function selectDocument(key: string): void {
    setSelectedKey(key);
    setPreviewOverride(null);
    setTab('body');
  }
  /** 과거 원본 선택은 같은 자료의 불변 판본만 바꾸고 목록의 최신 항목은 보존합니다. */
  function previewSource(reference: SourcePreviewRequest): void {
    if (
      !currentItem ||
      currentItem.kind !== 'source' ||
      currentItem.sourceId !== reference.sourceId
    )
      return;
    setPreviewOverride({
      ...currentItem,
      sourceVersion: reference.sourceVersion,
      sourceSha256: reference.sourceSha256,
      sizeBytes: reference.sizeBytes,
      format: reference.format,
    });
    setTab('body');
  }

  return (
    <WorkspaceLayout className={styles.layout}>
      <WorkspacePane name="index">
        <aside className={styles.index} aria-label="저장된 자료">
          <header className={styles.indexHeader}>
            <h2>저장된 자료</h2>
            {pinned && (
              <p className={styles.pinnedNotice}>
                {pinned.kind === 'source'
                  ? '방금 등록한 원본을 현재 페이지에 함께 표시합니다.'
                  : '선택한 연결 문서를 현재 페이지에 함께 표시합니다.'}
              </p>
            )}
            <form
              className={styles.filters}
              onSubmit={handleSubmit(applyFilters)}
              noValidate
              data-currentpage="true"
            >
              <TextField
                {...register('query', { onChange: clearSelection })}
                label="현재 페이지에서 찾기"
                aria-label="현재 페이지 검색"
                type="search"
                placeholder="제목·파일명"
                maxLength={300}
                disabled={!ready}
                error={errors.query?.message}
              />
              <div className={styles.filterRow}>
                <SelectField
                  {...register('folder', { onChange: clearSelection })}
                  label="문서 폴더"
                  disabled={!ready}
                >
                  <option value="">전체 폴더</option>
                  {folders.map((value: string): JSX.Element => (
                    <option key={value} value={value}>
                      {value === '/' ? '루트' : value}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  {...register('kind', { onChange: clearSelection })}
                  label="자료 종류"
                  disabled={!ready}
                >
                  <option value="all">모든 자료</option>
                  <option value="source">등록 원본</option>
                  <option value="wiki">위키</option>
                </SelectField>
              </div>
              <p className={styles.filterHint}>
                현재 페이지의 제목·경로만 찾습니다. 폴더는 위키 경로 기준입니다.
              </p>
            </form>
          </header>
          <ul role="list" aria-label="문서 목록" className={styles.rows}>
            <li role="presentation" className={styles.queryState}>
              <CatalogState state={state} />
            </li>
            {sources.length > 0 && (
              <li role="presentation" className={styles.groupLabel}>
                등록 원본
              </li>
            )}
            {sources.map((item: DocumentListItem): JSX.Element => (
              <DocumentRow
                key={documentItemKey(item)}
                item={item}
                selected={documentItemKey(item) === selectedKey}
                onSelect={selectDocument}
              />
            ))}
            {wikis.length > 0 && (
              <li role="presentation" className={styles.groupLabel}>
                원본 미연결 Wiki
              </li>
            )}
            {wikis.map((item: DocumentListItem): JSX.Element => (
              <DocumentRow
                key={documentItemKey(item)}
                item={item}
                selected={documentItemKey(item) === selectedKey}
                onSelect={selectDocument}
              />
            ))}
            {ready && ready.page.items.length > 0 && visible.length === 0 && (
              <li className={styles.filterEmpty}>
                조건에 맞는 자료가 없습니다.
                <small>
                  현재 페이지 검색어나 폴더·자료 종류를 확인해 주세요.
                </small>
              </li>
            )}
          </ul>
          <footer className={styles.indexFooter}>
            <p>
              {ready
                ? pinned
                  ? `현재 표시 ${visible.length}개 · 페이지 조회 ${pageItems.length}개 · ${pinned.kind === 'source' ? '방금 등록' : '연결 문서'} 1개`
                  : `현재 페이지 ${visible.length}개 표시 · 조회 항목 ${pageItems.length}개`
                : '목록 확인 전'}
              {ready && ready.page.nextCursor !== null
                ? ' · 다음 페이지 있음'
                : ''}
            </p>
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                onClick={previous}
                disabled={!ready || ready.previousCursors.length === 0}
              >
                이전 페이지
              </Button>
              <span>
                {ready ? `${ready.previousCursors.length + 1}페이지` : '—'}
              </span>
              <Button
                variant="secondary"
                onClick={next}
                disabled={
                  !ready ||
                  ready.page.nextCursor === null ||
                  ready.page.requiresRefresh
                }
              >
                다음 페이지
              </Button>
            </div>
          </footer>
        </aside>
      </WorkspacePane>
      <DocumentSelectionRegion
        key={`${currentItem ? documentItemKey(currentItem) : 'unselected'}:${tab}`}
        item={currentItem}
        state={state}
        onScopeInvalidated={refresh}
        onAnalyzeSource={onAnalyzeSource}
        tab={tab}
        onTabChange={setTab}
        renderPanel={renderPanel}
        onEditDocument={onEditDocument}
        onPreview={previewSource}
        onOpenDocument={(document: string): void => {
          void openDocument(document);
        }}
        onUpdated={showRegisteredSource}
      />
    </WorkspaceLayout>
  );
}

/** scope·목록 판본·cursor가 바뀌면 필터와 선택을 새 페이지 수명으로 분리합니다. */
function workspaceKey(state: DocumentListState): string {
  if (state.status !== 'ready') return state.status;
  return JSON.stringify([
    state.scope.connectionId,
    state.scope.userId,
    state.scope.tenant,
    state.scope.profileId,
    state.scope.policyRevision,
    state.page.catalogRevision,
    state.cursor,
    state.linkedDocument?.document,
  ]);
}

/** 서버 조회 동작은 기존 model에 맡기고 문서 화면의 세 영역을 조립합니다. */
export function ListDocuments({
  navigation,
  renderRegistration,
  onAnalyzeSource,
  renderPanel,
  onEditDocument,
  initialDocument,
}: ListDocumentsProps = {}): JSX.Element {
  const model = useDocumentList(initialDocument);
  const state = model.state;
  const scope =
    state.status === 'ready' || state.status === 'error' ? state.scope : null;
  return (
    <section
      className={styles.workspace}
      aria-labelledby="documents-title"
      aria-busy={state.status === 'loading'}
    >
      <WorkspaceToolbar className={styles.toolbar}>
        <h1 id="documents-title">문서 목록</h1>
        {scope ? (
          <span className={styles.toolbarScope}>
            {scope.tenant} <span aria-hidden="true">/</span> {scope.profileId}
          </span>
        ) : (
          <span className={styles.toolbarScope}>연결 범위 확인</span>
        )}
        <div className={styles.toolbarActions}>
          {navigation}
          {model.registration &&
            model.registration.connectionId === scope?.connectionId &&
            model.registration.access.userId === scope?.userId &&
            model.registration.access.policyRevision ===
              scope?.policyRevision &&
            model.registration.access.tenant === scope?.tenant && (
              <span role="status" className={styles.toolbarScope}>
                {state.status === 'error'
                  ? '원본 등록 완료 · 목록을 다시 불러와 주세요.'
                  : model.registration.cleanupWarningCount > 0
                    ? '등록 완료 · 임시 파일 정리 경고가 있습니다.'
                    : '원본 등록 완료'}
              </span>
            )}
          {renderRegistration?.({
            connectionId: scope?.connectionId || null,
            tenant: scope?.tenant || null,
            allowed: scope?.canRegisterSource === true,
            onRegistered: model.showRegisteredSource,
            onScopeInvalidated: model.refresh,
            expectedScope: scope
              ? {
                  userId: scope.userId,
                  tenant: scope.tenant,
                  profileId: scope.profileId,
                  policyRevision: scope.policyRevision,
                }
              : undefined,
          })}
          <Button
            variant="secondary"
            disabled={state.status === 'loading'}
            onClick={model.refresh}
          >
            새로고침
          </Button>
        </div>
      </WorkspaceToolbar>
      <DocumentWorkspace
        key={workspaceKey(state)}
        {...model}
        onAnalyzeSource={onAnalyzeSource}
        renderPanel={renderPanel}
        onEditDocument={onEditDocument}
      />
    </section>
  );
}
