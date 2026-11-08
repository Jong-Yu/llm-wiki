import { useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { compareLines, inlineChange } from '../lib/lineComparison';
import type { ComparedLine, ComparisonRow } from '../lib/lineComparison';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './LineComparison.module.scss';

type LineComparisonProps = {
  left: string;
  right: string;
  leftTitle: string;
  rightTitle: string;
  leftOffset?: number;
  rightOffset?: number;
};
type LineCellProps = {
  line: ComparedLine | undefined;
  other: ComparedLine | undefined;
  side: 'before' | 'after';
  changed: boolean;
  offset: number;
};
const PAGE = 120;

/** 공백과 줄 끝을 함께 표시하여 개행만 바뀐 경우도 식별할 수 있게 합니다. */
function LineCell({
  line,
  other,
  side,
  changed,
  offset,
}: LineCellProps): JSX.Element {
  const parts =
    line && changed && other ? inlineChange(line.text, other.text) : null;
  return (
    <div
      className={styles.cell}
      data-side={side}
      data-changed={changed && !!line}
    >
      <span className={styles.number}>
        <span className={styles.srOnly}>
          {`${side === 'before' ? '이전' : '이후'} 줄 ${line ? line.number + offset : '없음'}`}
        </span>
        <span aria-hidden="true">{line ? line.number + offset : ''}</span>
      </span>
      <span className={styles.sign}>
        {changed && line && (
          <span className={styles.srOnly}>
            {side === 'before' ? '삭제' : '추가'}
          </span>
        )}
        <span aria-hidden="true">
          {changed && line ? (side === 'before' ? '−' : '+') : ' '}
        </span>
      </span>
      <code>
        {line ? (
          <>
            {parts ? (
              <>
                {parts[0]}
                <mark>{parts[1]}</mark>
                {parts[2]}
              </>
            ) : (
              line.text
            )}
            <small className={styles.ending}>
              {line.ending === '\r\n'
                ? ' ↵ CRLF'
                : line.ending === '\r'
                  ? ' ↵ CR'
                  : line.ending === '\n'
                    ? ' ↵ LF'
                    : ' ∅ 최종 개행 없음'}
            </small>
          </>
        ) : (
          <span className={styles.absent}>줄 없음</span>
        )}
      </code>
    </div>
  );
}

/** 변경 구간과 문맥을 페이지로 표시해 큰 입력에서도 DOM 크기를 제한합니다. */
export function LineComparison({
  left,
  right,
  leftTitle,
  rightTitle,
  leftOffset = 0,
  rightOffset = 0,
}: LineComparisonProps): JSX.Element {
  // 같은 비교 내 이동에서 최대 1 MiB 문서를 다시 계산하지 않습니다.
  const diff = useMemo(
    (): ReturnType<typeof compareLines> => compareLines(left, right),
    [left, right],
  );
  const [position, setPosition] = useState(0);
  const [page, setPage] = useState(0);
  const [context, setContext] = useState(3);
  const [all, setAll] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = Math.min(position, Math.max(0, diff.changes.length - 1));
  const change = diff.changes[active];
  const start = all || !change ? 0 : Math.max(0, change.start - context);
  const end =
    all || !change
      ? diff.rows.length
      : Math.min(diff.rows.length, change.end + context);
  const pages = Math.max(1, Math.ceil((end - start) / PAGE));
  const currentPage = Math.min(page, pages - 1);
  const offset = start + currentPage * PAGE;
  /** 이동 결과에 키보드 초점을 두고 같은 패널에서 읽도록 합니다. */
  function move(next: number): void {
    setPosition(next);
    setPage(0);
    setAll(false);
    setContext(3);
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest' });
  }
  return (
    <section className={styles.root} aria-label="줄별 비교">
      <div className={styles.toolbar}>
        <h4 ref={heading} tabIndex={-1}>
          줄별 변경
          <span className={styles.added}>+{diff.added} 추가</span>
          <span className={styles.removed}>−{diff.removed} 삭제</span>
        </h4>
        <nav aria-label="변경 구간 이동" className={styles.stepper}>
          <button
            aria-label="이전 변경"
            title="이전 변경"
            disabled={!change || active === 0}
            onClick={(): void => move(active - 1)}
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <span role="status">
            {change
              ? `${active + 1} / ${diff.changes.length} 변경 구간`
              : '변경 없음'}
          </span>
          <button
            aria-label="다음 변경"
            title="다음 변경"
            disabled={!change || active === diff.changes.length - 1}
            onClick={(): void => move(active + 1)}
          >
            <Icon name="chevron-right" size={16} />
          </button>
        </nav>
        <div className={styles.view} role="group" aria-label="표시 범위">
          <button
            aria-pressed={!all}
            onClick={(): void => {
              setAll(false);
              setPage(0);
            }}
          >
            변경 주변만 보기
          </button>
          <button
            aria-pressed={all}
            onClick={(): void => {
              setAll(true);
              setPage(0);
            }}
          >
            전체 줄 보기
          </button>
        </div>
      </div>
      {diff.coarse && (
        <p role="status">
          큰 변경 범위는 삭제·추가 묶음으로 표시합니다. 일부 같은 줄도 변경
          건수에 포함될 수 있으며 모든 줄은 페이지로 확인할 수 있습니다.
        </p>
      )}
      <div className={styles.titles}>
        <strong>− {leftTitle}</strong>
        <strong>+ {rightTitle}</strong>
      </div>
      {!all && start > 0 && (
        <button
          className={styles.context}
          onClick={(): void => {
            setContext(context + PAGE);
            setPage(0);
          }}
        >
          펼치기 (앞에 {start}줄 더 있음)
        </button>
      )}
      {diff.rows.length === 0 && <p>두 본문 모두 비어 있습니다.</p>}
      <div className={styles.rows}>
        {diff.rows
          .slice(offset, Math.min(end, offset + PAGE))
          .map((row: ComparisonRow, index: number): JSX.Element => (
            <div
              className={styles.row}
              data-kind={row.kind}
              key={offset + index}
            >
              <LineCell
                line={row.before}
                other={row.after}
                side="before"
                offset={leftOffset}
                changed={row.kind === 'change'}
              />
              <LineCell
                line={row.after}
                other={row.before}
                side="after"
                offset={rightOffset}
                changed={row.kind === 'change'}
              />
            </div>
          ))}
      </div>
      {pages > 1 && (
        <nav className={styles.pagination} aria-label="비교 줄 페이지">
          <button
            disabled={currentPage === 0}
            onClick={(): void => setPage(currentPage - 1)}
          >
            이전 줄
          </button>
          <span role="status">
            {currentPage + 1} / {pages}쪽, {offset + 1}–
            {Math.min(end, offset + PAGE)} / {diff.rows.length}행
          </span>
          <button
            disabled={currentPage === pages - 1}
            onClick={(): void => setPage(currentPage + 1)}
          >
            다음 줄
          </button>
        </nav>
      )}
      {!all && end < diff.rows.length && (
        <button
          className={styles.context}
          onClick={(): void => setContext(context + PAGE)}
        >
          펼치기 (뒤에 {diff.rows.length - end}줄 더 있음)
        </button>
      )}
    </section>
  );
}
