import type { ChangeEvent, JSX, KeyboardEvent, SubmitEvent } from 'react';
import type {
  OntologyMapConcept,
  OntologySearchItem,
  OntologySearchPage,
} from '@contracts/ontologyExploration.contract';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { SkeletonBar, SkeletonText } from '@renderer/shared/ui/Skeleton';
import { conceptKey } from '../model/buildOntologyGraph';
import { OntologyCoverageNotice } from './OntologyCoverageNotice';
import type { ExplorationSeed } from '../model/useOntologyExploration';
import styles from './OntologyExplorer.module.scss';

type OntologySearchPanelProps = {
  query: string;
  input: string;
  kind: 'all' | 'concept' | 'document';
  page: OntologySearchPage | null;
  searching: boolean;
  busy: string[];
  seeds: ExplorationSeed[];
  onInput: (value: string) => void;
  onSubmit: () => void;
  onKind: (kind: 'all' | 'concept' | 'document') => void;
  onAdd: (concept: OntologyMapConcept) => void;
  onMore: () => void;
  documentFilter: string | null;
  onDocument: (document: string | null) => void;
  onClose?: () => void;
  showIntroduction?: boolean;
};

/** 전역 검색과 문서의 개념 목록을 시작 화면과 지도 옆에서 공유합니다. */
export function OntologySearchPanel(
  props: OntologySearchPanelProps,
): JSX.Element {
  const {
    query,
    input,
    kind,
    page,
    searching,
    busy,
    seeds,
    onInput,
    onSubmit,
    onKind,
    onAdd,
    onMore,
    onClose,
    documentFilter,
    onDocument,
  } = props;
  const recent = !query && !documentFilter;
  const showIntroduction = props.showIntroduction !== false && !onClose;
  /** 개념은 이름·출처·추가 상태로 구분하고 문서는 개념 목록을 엽니다. */
  function renderItem(item: OntologySearchItem): JSX.Element {
    if (item.kind === 'concept') {
      const key = conceptKey(item.concept.document, item.concept.entity_id);
      const added = seeds.some(
        (seed: ExplorationSeed): boolean =>
          conceptKey(seed.concept.document, seed.concept.entity_id) === key,
      );
      const loading = busy.includes(key);
      return (
        <li key={key} className={`${styles.result} ${styles.conceptResult}`}>
          <Icon name="network" size={16} />
          <div className={styles.resultContent}>
            <strong>{item.concept.name}</strong>
            <small>{documentDisplayName(item.concept.document)}</small>
          </div>
          <button
            type="button"
            className={styles.addConcept}
            data-added={added}
            disabled={loading}
            aria-label={`${item.concept.name} ${loading ? '불러오는 중' : added ? '추가됨 · 지도에서 보기' : '지도에 추가'}`}
            title={added ? '지도에서 보기' : undefined}
            onClick={(): void => onAdd(item.concept)}
          >
            <Icon
              name={loading ? 'loader-circle' : added ? 'check' : 'plus'}
              size={14}
            />
            {loading ? '추가 중' : added ? '추가됨' : '추가'}
          </button>
        </li>
      );
    }
    if (recent)
      return (
        <li key={item.ref.document} className={styles.recentItem}>
          <button
            type="button"
            className={styles.recentDocument}
            title={item.title}
            onClick={(): void => onDocument(item.ref.document)}
          >
            <Icon name="file-text" size={17} />
            <strong>{item.title}</strong>
            <span>
              개념 {item.concept_count.toLocaleString()} · 관계{' '}
              {item.relation_count.toLocaleString()}
              {item.ref.status !== 'ready' && (
                <small>
                  {item.ref.status === 'needs_reextraction' ||
                  item.ref.status === 'stale'
                    ? '재추출 필요'
                    : item.ref.status === 'missing'
                      ? '미추출'
                      : '상태 확인 필요'}
                </small>
              )}
            </span>
            <Icon name="chevron-right" size={16} />
          </button>
        </li>
      );
    return (
      <li key={item.ref.document} className={styles.documentResult}>
        <button
          type="button"
          className={styles.openDocument}
          aria-label={`${item.title} · 개념 목록 열기`}
          onClick={(): void => onDocument(item.ref.document)}
        >
          <Icon name="file-text" size={16} />
          <span>
            <strong>{item.title}</strong>
            <small>
              문서 · 개념 {item.concept_count.toLocaleString()}개
              {item.ref.status !== 'ready'
                ? ` · ${item.ref.status === 'needs_reextraction' || item.ref.status === 'stale' ? '재추출 필요' : item.ref.status === 'missing' ? '미추출' : '상태 확인 필요'}`
                : ''}
            </small>
          </span>
          <Icon name="chevron-right" size={16} />
        </button>
      </li>
    );
  }
  return (
    <section
      onKeyDown={(event: KeyboardEvent<HTMLElement>): void => {
        if (event.key === 'Escape' && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
      className={styles.searchPanel}
      aria-label="전체 문서에서 개념 찾기"
    >
      <header className={styles.panelHeading}>
        <h2>
          {documentFilter
            ? '문서의 개념'
            : onClose
              ? '개념 추가'
              : query
                ? `“${query}” 검색 결과`
                : '개념 탐색'}
        </h2>
        {onClose && (
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="개념 찾기 닫기"
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </header>
      <form
        className={styles.searchForm}
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className={styles.searchBox}>
          <Icon name="search" size={16} />
          <input
            autoFocus
            aria-label="전체 문서에서 개념이나 문서 검색"
            placeholder="개념이나 문서 이름 검색"
            value={input}
            maxLength={200}
            onChange={(event: ChangeEvent<HTMLInputElement>): void =>
              onInput(event.target.value)
            }
          />
        </label>
        <button type="submit">검색</button>
      </form>
      {documentFilter && (
        <div className={styles.documentFilter}>
          <span>개념 목록 · {documentDisplayName(documentFilter)}</span>
          <button type="button" onClick={(): void => onDocument(null)}>
            목록 닫기
          </button>
        </div>
      )}
      {query && !documentFilter ? (
        <div className={styles.tabs} role="group" aria-label="검색 대상">
          {(['all', 'concept', 'document'] as const).map(
            (value: 'all' | 'concept' | 'document'): JSX.Element => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={(): void => onKind(value)}
              >
                {value === 'all'
                  ? '전체'
                  : value === 'concept'
                    ? '개념'
                    : '문서'}
              </button>
            ),
          )}
        </div>
      ) : !documentFilter ? (
        <>
          {showIntroduction && (
            <div className={styles.intro}>
              <Icon name="network" size={24} />
              <h3>어떤 개념부터 살펴볼까요?</h3>
              <p>전체 문서에서 찾아 연결을 따라가 보세요.</p>
            </div>
          )}
          <div className={styles.recentHeading}>
            <strong>최근 변경된 문서</strong>
            <span>최근 {page?.items.length ?? 5}개</span>
          </div>
        </>
      ) : null}
      <div className={styles.results} aria-busy={searching}>
        {page && searching && (
          <p className={styles.coverage} role="status">
            검색 결과를 갱신하고 있습니다.
          </p>
        )}
        {!page && searching ? (
          <div role="status" aria-label="검색 결과 불러오는 중">
            {Array.from(
              { length: recent ? 5 : 3 },
              (_: unknown, key: number): JSX.Element =>
                recent ? (
                  <div className={styles.recentSkeleton} key={key}>
                    <SkeletonBar shape="icon" />
                    <SkeletonBar shape="title" />
                    <SkeletonBar shape="badge" />
                  </div>
                ) : (
                  <div
                    className={`${styles.result} ${styles.conceptResult}`}
                    key={key}
                  >
                    <SkeletonBar shape="icon" />
                    <div>
                      <SkeletonText lines={2} />
                    </div>
                    <SkeletonBar shape="badge" />
                  </div>
                ),
            )}
          </div>
        ) : (
          <ul className={recent ? styles.recentList : undefined}>
            {page?.items.map(renderItem)}
          </ul>
        )}
        {page?.items.length === 0 && (
          <div className={styles.empty}>
            <strong>
              {query || documentFilter
                ? '일치하는 결과가 없습니다'
                : '아직 탐색할 문서가 없습니다'}
            </strong>
            <p>
              {query || documentFilter
                ? '다른 개념이나 문서 이름으로 검색해 주세요.'
                : '문서를 추가하고 분석하면 이곳에서 개념을 찾을 수 있습니다.'}
            </p>
          </div>
        )}
        {page && (
          <OntologyCoverageNotice
            coverage={page.coverage}
            scope="검색 대상 전체 문서"
          />
        )}
        {page && page.items.length > 0 && (
          <footer
            className={`${styles.resultFoot} ${recent ? styles.recentFoot : ''}`}
          >
            <span>
              {recent
                ? `전체 문서 ${page.total.toLocaleString()}개 중 최근 ${page.items.length}개`
                : page.next_cursor
                  ? `불러온 ${page.items.length} / ${page.total.toLocaleString()}건`
                  : documentFilter
                    ? `개념 ${page.total.toLocaleString()}개`
                    : `검색 결과 ${page.total.toLocaleString()}건`}
            </span>
            {page.next_cursor && (
              <button type="button" disabled={searching} onClick={onMore}>
                {searching
                  ? '불러오는 중'
                  : recent
                    ? '문서 더 보기'
                    : '더 보기'}
                <Icon name="chevron-down" size={14} />
              </button>
            )}
          </footer>
        )}
      </div>
    </section>
  );
}
