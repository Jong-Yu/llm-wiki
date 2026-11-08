import { documentDisplayName } from '@renderer/domains/documents';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, MouseEvent, ReactNode, RefObject } from 'react';
import { Link } from 'react-router';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { EmptyState } from '@renderer/shared/ui/PageNotice';
import { Icon } from '@renderer/shared/ui/Icon';
import { SkeletonBar, SkeletonList } from '@renderer/shared/ui/Skeleton';
import { useReviewQueue } from '../model/useReviewQueue';
import {
  reviewQueueKindLabel,
  reviewQueueSkippedReason,
  summarizeReviewQueue,
} from '../model/reviewQueuePresentation';
import type { ReviewGroup } from '../model/reviewQueuePresentation';
import type {
  ReviewQueueItem,
  ReviewQueuePage as ReviewQueueResult,
  ReviewQueueState,
} from '../model/reviewQueue.types';
import styles from './ReviewQueue.module.scss';

type ReviewFilter = ReviewQueueState | 'all';
type ReviewFilterOption = {
  value: ReviewFilter;
  label: string;
  states: readonly ReviewQueueState[];
};
type ReviewQueueEntryProps = {
  item: ReviewQueueItem;
  selected: boolean;
  disabled: boolean;
  detailId: string;
  onSelect: (key: string, button: HTMLButtonElement) => void;
};
type ReviewQueueDetailProps = {
  item: ReviewQueueItem;
  narrow: boolean;
  notices?: ReactNode;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
};
type ReviewQueueResultsProps = {
  /** 목록 위쪽에 붙는 필터·새로고침·조회 범위입니다. */
  toolbar: ReactNode;
  notices: ReactNode;
  /** 목록이 가려진 좁은 화면의 상세에서도 다시 조회할 수 있게 합니다. */
  onRefresh: () => void;
  page: ReviewQueueResult;
  busy: boolean;
  refreshRequired: boolean;
  hasIncompleteScope: boolean;
  onLoadMore: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
  initialSelectedKey: string | null;
  renderWorkbench?: RenderReviewWorkbench;
  /** 판단을 저장한 뒤 다음에 열 항목의 key와 함께 목록을 다시 읽게 합니다. */
  onDecided: (nextKey: string | null) => void;
};
type ReviewStateProps = { item: ReviewQueueItem };
/** 항목을 판단하는 화면은 업무 feature가 채우고, 없으면 기본 상세를 보여 줍니다. */
export type RenderReviewWorkbench = (
  item: ReviewQueueItem,
  onDecided: () => void,
) => ReactNode | null;
export type ReviewQueueProps = { renderWorkbench?: RenderReviewWorkbench };
type SkippedItem = ReviewQueueResult['skipped'][number];

const filters: readonly ReviewFilterOption[] = [
  { value: 'all', label: '전체', states: ['unreviewed', 'defer', 'pending'] },
  { value: 'unreviewed', label: '검토 대기', states: ['unreviewed'] },
  { value: 'defer', label: '보류', states: ['defer'] },
  { value: 'pending', label: '다시 검토', states: ['pending'] },
];

/** 목록과 상세에서 동일한 상태 이름을 표시합니다. */
function ReviewState({ item }: ReviewStateProps): JSX.Element {
  return (
    <span className={styles.state} data-state={item.status}>
      <Icon
        name={
          item.status === 'defer'
            ? 'pause'
            : item.status === 'pending'
              ? 'circle-alert'
              : 'circle-help'
        }
        size={13}
      />
      {item.statusLabel}
    </span>
  );
}

/** 행은 선택만 담당하고 목적지 이동과 근거 확인은 선택 상세에서 제공합니다. */
function ReviewQueueEntry({
  item,
  selected,
  disabled,
  detailId,
  onSelect,
}: ReviewQueueEntryProps): JSX.Element {
  return (
    <li className={styles.item} data-review-kind={item.kind}>
      <button
        type="button"
        className={styles.row}
        data-review-select=""
        aria-pressed={selected}
        aria-controls={detailId}
        disabled={disabled}
        onClick={(event: MouseEvent<HTMLButtonElement>): void =>
          onSelect(item.key, event.currentTarget)
        }
      >
        <span
          className={styles.dot}
          data-state={item.status}
          aria-hidden="true"
        />
        <span className={styles.rowTitle} data-review-title="">
          {item.title}
        </span>
        {item.status !== 'unreviewed' && <ReviewState item={item} />}
      </button>
    </li>
  );
}

/** 선택한 대상의 전체 제목·원문 인용·행동을 한곳에서 확인합니다. */
function ReviewQueueDetail({
  item,
  narrow,
  notices,
  headingRef,
  onClose,
}: ReviewQueueDetailProps): JSX.Element {
  return (
    <>
      <div className={styles.detailToolbar}>
        <div className={styles.detailIdentity}>
          <span>{reviewQueueKindLabel(item.kind)}</span>
          <ReviewState item={item} />
        </div>
        <Button
          variant="secondary"
          size="small"
          className={narrow ? undefined : styles.iconButton}
          aria-label={narrow ? '목록으로' : '상세 닫기'}
          title={narrow ? '목록으로' : '상세 닫기'}
          onClick={onClose}
        >
          <Icon name={narrow ? 'arrow-left' : 'x'} />
          {narrow && '목록으로'}
        </Button>
      </div>
      <div className={styles.detailContent}>
        <h2 ref={headingRef} tabIndex={-1}>
          {item.title}
        </h2>
        {notices}
        <dl className={styles.properties}>
          <dt>문서</dt>
          <dd>
            {item.document ? (
              <Link
                to={`/document?path=${encodeURIComponent(item.document)}`}
                className={styles.documentLink}
              >
                <Icon name="file-text" />
                {documentDisplayName(item.document)}
              </Link>
            ) : (
              '문서 간 대응'
            )}
          </dd>
        </dl>
        {item.detail && <p className={styles.description}>{item.detail}</p>}
        {item.kind !== 'correspondence_judgment' &&
          item.href &&
          item.actionLabel && (
            <Link
              to={item.href}
              className={styles.primaryAction}
              data-review-action=""
            >
              {item.actionLabel}
              <Icon name="arrow-right" />
            </Link>
          )}
        {item.evidence && (
          <section className={styles.evidence} aria-label="원문 근거">
            <header>
              <h3>원문 근거</h3>
              {item.evidence.location && <span>{item.evidence.location}</span>}
            </header>
            <blockquote data-review-evidence="">
              {item.evidence.quote}
            </blockquote>
          </section>
        )}
      </div>
    </>
  );
}

/** 같은 조회 범위 안에서만 선택을 보관하고 좁은 화면의 상세 왕복 초점을 복원합니다. */
function ReviewQueueResults({
  toolbar,
  notices,
  onRefresh,
  page,
  busy,
  refreshRequired,
  hasIncompleteScope,
  onLoadMore,
  fallbackFocus,
  initialSelectedKey,
  renderWorkbench,
  onDecided,
}: ReviewQueueResultsProps): JSX.Element {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<'detail' | 'list' | null>(null);
  const [wide, setWide] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initialSelectedKey,
  );
  const item = refreshRequired
    ? undefined
    : page.items.find(
        (entry: ReviewQueueItem): boolean => entry.key === selectedKey,
      );
  const showList = wide || !item;

  useLayoutEffect((): (() => void) | undefined => {
    const element = root.current;
    if (!element) return;
    /** 화면 전체가 아닌 실제 본문 너비로 두 패널의 표시 여부를 결정합니다. */
    const measure = (): void => {
      const pageWidth =
        element.closest('[data-review-page]')?.getBoundingClientRect().width ??
        element.getBoundingClientRect().width;
      const nextWide = pageWidth >= 900;
      if (!nextWide && listPane.current?.contains(document.activeElement))
        pendingFocus.current = 'detail';
      setWide(nextWide);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element.closest('[data-review-page]') ?? element);
    return (): void => observer.disconnect();
  }, []);

  useLayoutEffect((): (() => void) => {
    const element = root.current;
    const fallback = fallbackFocus.current;
    // 조회 경계로 상세가 사라진 동안 다른 곳으로 옮긴 초점은 가져오지 않습니다.
    if (document.activeElement === fallback)
      listPane.current?.focus({ preventScroll: true });
    return (): void => {
      if (element?.contains(document.activeElement))
        fallback?.focus({ preventScroll: true });
    };
  }, [fallbackFocus]);

  useLayoutEffect((): void => {
    if (pendingFocus.current === 'list' && showList) {
      pendingFocus.current = null;
      const previous = selectedButton.current;
      if (previous?.isConnected && !previous.disabled)
        previous.focus({ preventScroll: wide });
      else listPane.current?.focus({ preventScroll: true });
    } else if (
      item &&
      !wide &&
      (pendingFocus.current === 'detail' ||
        listPane.current?.contains(document.activeElement))
    ) {
      pendingFocus.current = null;
      detailHeading.current?.focus();
    } else if (wide) pendingFocus.current = null;
  }, [item, showList, wide]);

  /** 선택 행 참조는 목록으로 돌아갈 때만 사용하고 서버 참조와 분리합니다. */
  function select(key: string, button: HTMLButtonElement): void {
    selectedButton.current = button;
    pendingFocus.current = 'detail';
    setSelectedKey(key);
  }

  /** 숨겨진 목록을 다시 표시한 다음 원래 선택 행으로 초점을 돌립니다. */
  function close(): void {
    pendingFocus.current = 'list';
    setSelectedKey(null);
  }

  const { groups, counts } = summarizeReviewQueue(page.items);
  const workbench = item
    ? (renderWorkbench?.(item, (): void => {
        const index = page.items.findIndex(
          (entry: ReviewQueueItem): boolean => entry.key === item.key,
        );
        onDecided(
          page.items[index + 1]?.key ?? page.items[index - 1]?.key ?? null,
        );
      }) ?? null)
    : null;
  return (
    <div
      ref={root}
      className={styles.workspace}
      data-layout={wide ? 'wide' : 'narrow'}
      data-detail-open={Boolean(item)}
    >
      <section
        ref={listPane}
        className={`${styles.panel} ${styles.listPane}`}
        aria-label="검토 목록"
        hidden={!showList}
        tabIndex={-1}
      >
        {toolbar}
        {notices}
        {page.items.length === 0 && !busy && (
          <p className={styles.listEmpty}>
            {hasIncompleteScope
              ? '일부 자료는 확인하지 못했습니다. 조회 안내를 확인해 주세요.'
              : '표시할 항목이 없습니다.'}
          </p>
        )}
        {groups.map((group: ReviewGroup): JSX.Element => (
          <section key={group.name} className={styles.group}>
            <h2 className={styles.groupTitle}>
              <Icon name="file-text" size={13} />
              <span>{group.name}</span>
            </h2>
            <ul className={styles.list} aria-label={`${group.name} 검토 항목`}>
              {group.items.map((entry: ReviewQueueItem): JSX.Element => (
                <ReviewQueueEntry
                  key={entry.key}
                  item={entry}
                  selected={entry.key === item?.key}
                  disabled={refreshRequired}
                  detailId={`${id}-detail`}
                  onSelect={select}
                />
              ))}
            </ul>
          </section>
        ))}
        {(page.nextCursor || hasIncompleteScope) && (
          <div className={styles.pagination}>
            {page.nextCursor ? (
              <Button
                variant="secondary"
                onClick={onLoadMore}
                disabled={busy || refreshRequired}
              >
                더 불러오기
              </Button>
            ) : (
              <p className={styles.note}>
                더 불러올 페이지는 없습니다. 조회 한도와 누락 안내를 확인해
                주세요.
              </p>
            )}
          </div>
        )}
      </section>
      <section
        key={item?.key ?? 'unselected'}
        id={`${id}-detail`}
        className={`${styles.panel} ${styles.detailPane}`}
        aria-label="선택한 검토 항목"
        hidden={!item && !wide}
        data-review-detail={item ? '' : undefined}
      >
        {item && workbench ? (
          <>
            {!wide && (
              <div className={styles.backBar}>
                <Button variant="secondary" size="small" onClick={close}>
                  <Icon name="arrow-left" />
                  목록으로
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={onRefresh}
                  disabled={busy}
                  aria-label="새로고침"
                  title="새로고침"
                >
                  <Icon name="refresh-cw" />
                </Button>
              </div>
            )}
            {!showList && notices}
            {workbench}
          </>
        ) : item ? (
          <ReviewQueueDetail
            key={item.key}
            item={item}
            narrow={!wide}
            notices={!showList ? notices : undefined}
            headingRef={detailHeading}
            onClose={close}
          />
        ) : (
          <div className={styles.empty}>
            <Icon name="clipboard-check" size={24} />
            {page.items.length === 0 && !busy ? (
              <>
                <h2>검토할 항목이 없습니다</h2>
                <p>새 관계가 추출되면 이곳에 쌓입니다.</p>
              </>
            ) : (
              <>
                <h2>검토할 항목을 왼쪽에서 선택하세요</h2>
                <p>
                  검토 대기 {counts.unreviewed} · 보류 {counts.defer} · 다시
                  검토 {counts.pending}
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** 현재 작업 공간의 검토 대상을 조회하고 목록·원문·판단을 분리된 패널로 보여 줍니다. */
export function ReviewQueue({
  renderWorkbench,
}: ReviewQueueProps): JSX.Element {
  const [filter, setFilter] = useState<ReviewFilter>('all');
  // 판단 저장 뒤 목록을 다시 읽어도 다음 항목이 이어서 열리게 하는 힌트입니다.
  const [advance, setAdvance] = useState<{
    filter: ReviewFilter;
    key: string | null;
  } | null>(null);
  const queuePanel = useRef<HTMLDivElement>(null);
  const refocusFilter = useRef(false);
  const selected =
    filters.find(
      (option: ReviewFilterOption): boolean => option.value === filter,
    ) ?? filters[0];
  const model = useReviewQueue(selected.states);
  const page = model.page;
  // 필터를 바꾸면 목록 패널이 다시 만들어지므로 새 필터 상자로 초점을 되돌립니다.
  useLayoutEffect((): void => {
    if (!refocusFilter.current || !page) return;
    const select = queuePanel.current?.querySelector('select');
    if (select) {
      refocusFilter.current = false;
      select.focus({ preventScroll: true });
    }
  });
  const hasIncompleteScope =
    page !== null &&
    (!page.scopeComplete || page.truncated || page.skipped.length > 0);
  // 조회 안내는 필터 헤더 뒤, 해당 목록의 스크롤 영역 안에 둡니다.
  const queueNotices = (
    <div className={styles.listNotices}>
      {model.error && page && (
        <StatusNotice tone="error" title="검토함을 불러오지 못했습니다">
          {model.error}
        </StatusNotice>
      )}
      {(model.refreshRequired || page?.requiresRefresh) && (
        <StatusNotice tone="warning" title="목록을 새로 확인해 주세요">
          조회 기준이 바뀌었습니다. 새로고침으로 첫 목록부터 다시 확인할 수
          있습니다.
        </StatusNotice>
      )}
      {model.busy && page && (
        <p className={styles.loading} role="status">
          검토 항목을 불러오고 있습니다…
        </p>
      )}
      {page && (
        <>
          {(hasIncompleteScope || page.messages.length > 0) && (
            <StatusNotice tone="warning" title="조회 안내">
              {page.messages.length > 0
                ? page.messages.map(
                    (message: string, index: number): JSX.Element => (
                      <p
                        key={`${index}:${message}`}
                        className={styles.noticeMessage}
                      >
                        {message}
                      </p>
                    ),
                  )
                : '일부 대상만 확인했습니다. 누락된 자료와 조회 한도를 확인해 주세요.'}
            </StatusNotice>
          )}
          {page.skipped.length > 0 && (
            <details className={styles.skipped} data-review-skipped="">
              <summary>확인하지 못한 대상 {page.skipped.length}건</summary>
              <ul>
                {page.skipped.map(
                  (item: SkippedItem, index: number): JSX.Element => (
                    <li key={`${index}:${item.kind}:${item.reference}`}>
                      <strong>
                        {item.kind === 'document'
                          ? documentDisplayName(item.reference)
                          : reviewQueueKindLabel(item.kind)}
                      </strong>
                      <span>{reviewQueueSkippedReason(item.code)}</span>
                    </li>
                  ),
                )}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
  const listToolbar = (
    <div className={styles.listToolbar}>
      <div className={styles.filterRow}>
        <select
          className={styles.filter}
          aria-label="검토 상태 필터"
          value={filter}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            setAdvance(null);
            refocusFilter.current = true;
            setFilter(
              filters.find(
                (option: ReviewFilterOption): boolean =>
                  option.value === event.target.value,
              )?.value ?? 'all',
            );
          }}
        >
          {filters.map((option: ReviewFilterOption): JSX.Element => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="small"
          onClick={(): void => {
            setAdvance(null);
            model.reload();
          }}
          disabled={model.busy}
          aria-label="새로고침"
          title="새로고침"
        >
          <Icon name="refresh-cw" />
        </Button>
      </div>
      <details className={styles.coverage} data-review-coverage="">
        <summary
          data-partial={page ? page.items.length < page.totalItems : false}
        >
          <span>검토 항목</span>
          <span className={styles.coverageCount}>
            {page
              ? `${page.items.length.toLocaleString('ko-KR')} / ${page.totalItems.toLocaleString('ko-KR')}건`
              : '조회 범위'}
          </span>
          <Icon name="chevron-down" size={14} />
        </summary>
        <div className={styles.coverageBody}>
          <p>
            현재 작업 공간 · {selected.label}
            {page && (
              <>
                {' · '}조회한 대상 {page.totalItems.toLocaleString('ko-KR')}
                건 중 {page.items.length.toLocaleString('ko-KR')}건 불러옴
              </>
            )}
          </p>
          <p>
            정해진 한도 안에서 조회한 목록이며 문서마다 확인 시점이 다를 수
            있습니다.
          </p>
        </div>
      </details>
    </div>
  );
  return (
    <div className={styles.root} data-review-page="">
      <div
        ref={queuePanel}
        className={styles.queuePanel}
        aria-label="검토할 항목"
        tabIndex={-1}
      >
        {model.error && !page && (
          <section
            className={`${styles.panel} ${styles.initialPanel}`}
            aria-label="검토 목록"
          >
            {listToolbar}
            {queueNotices}
            <EmptyState
              className={styles.initialState}
              title="검토함을 불러오지 못했습니다"
              description={model.error}
              action={
                <Button
                  variant="secondary"
                  size="small"
                  onClick={(): void => {
                    setAdvance(null);
                    model.reload();
                  }}
                  disabled={model.busy}
                >
                  다시 불러오기
                </Button>
              }
            />
          </section>
        )}
        {model.busy && !page && !model.error && (
          <div className={`${styles.workspace} ${styles.queueLoading}`}>
            <section
              className={`${styles.panel} ${styles.listPane}`}
              aria-label="검토 목록"
            >
              {listToolbar}
              {queueNotices}
              <SkeletonList
                label="검토 항목을 불러오는 중"
                className={styles.queueSkeleton}
              >
                <div className={styles.groupTitle} aria-hidden="true">
                  <SkeletonBar shape="icon" />
                  <SkeletonBar shape="badge" />
                </div>
                {[0, 1, 2, 3, 4, 5].map((index: number): JSX.Element => (
                  <div className={styles.row} key={index} aria-hidden="true">
                    <SkeletonBar shape="icon" className={styles.skeletonDot} />
                    <span className={styles.rowTitle}>
                      <SkeletonBar shape="title" />
                    </span>
                    <SkeletonBar shape="badge" />
                  </div>
                ))}
              </SkeletonList>
            </section>
            <section
              className={`${styles.panel} ${styles.detailPane} ${styles.loadingDetail}`}
              aria-hidden="true"
            >
              <div className={styles.empty}>
                <SkeletonBar shape="icon" />
                <SkeletonBar shape="line" />
                <SkeletonBar shape="badge" />
              </div>
            </section>
          </div>
        )}
        {page && (
          <>
            <ReviewQueueResults
              key={`${filter}:${page.scopeKey}:${page.snapshotRevision}:${model.refreshRequired || page.requiresRefresh}`}
              toolbar={listToolbar}
              notices={queueNotices}
              onRefresh={(): void => {
                setAdvance(null);
                model.reload();
              }}
              page={page}
              busy={model.busy}
              refreshRequired={model.refreshRequired || page.requiresRefresh}
              hasIncompleteScope={hasIncompleteScope}
              onLoadMore={model.loadMore}
              fallbackFocus={queuePanel}
              initialSelectedKey={
                advance?.filter === filter ? advance.key : null
              }
              renderWorkbench={renderWorkbench}
              onDecided={(nextKey: string | null): void => {
                setAdvance({ filter, key: nextKey });
                model.reload();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
