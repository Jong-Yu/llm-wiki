import { Fragment, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import { documentDisplayName } from '@renderer/domains/documents';
import { valueObject } from '../model/buildOntologyGraph';
import type { CorrectionBasis } from '../model/ontologyMap.types';
import { useClaimBasis } from '../model/useClaimBasis';
import { OntologyClaimJudgment } from './OntologyClaimJudgment';
import styles from './OntologyClaimWorkbench.module.scss';

export type OntologyClaimWorkbenchProps = {
  document: string;
  claimId: string;
  onDecided: () => void;
};
type LineRange = { start: number; end: number };

/** 저장된 근거의 시작·끝 줄을, 없으면 인용문이 처음 나오는 줄을 찾습니다. */
function evidenceRange(basis: CorrectionBasis, lines: string[]): LineRange {
  const claim = basis.assertion.claim;
  const evidence = valueObject(
    claim?.reviewed_value.evidence ?? claim?.value.evidence,
  );
  const start = evidence?.start_line;
  const end = evidence?.end_line;
  if (
    typeof start === 'number' &&
    Number.isInteger(start) &&
    start >= 1 &&
    start <= lines.length
  )
    return {
      start,
      end:
        typeof end === 'number' && end >= start
          ? Math.min(end, lines.length)
          : start,
    };
  const quote =
    typeof evidence?.quote === 'string' ? evidence.quote.trim() : '';
  const first = quote.split('\n')[0]?.trim() ?? '';
  const index = first
    ? lines.findIndex((line: string): boolean => line.includes(first))
    : -1;
  return index < 0
    ? { start: 0, end: 0 }
    : { start: index + 1, end: index + 1 + quote.split('\n').length - 1 };
}

/** 맨 앞의 `---`로 둘러싼 문서 정보(앞머리)가 끝나는 줄 번호를 찾고, 없으면 0입니다. */
function frontMatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const closing = lines.findIndex(
    (line: string, index: number): boolean =>
      index > 0 && line.trim() === '---',
  );
  return closing < 0 ? 0 : closing + 1;
}

/** 줄 번호가 있는 원문에 근거 줄을 강조하고 그 바로 아래에서 판단합니다. */
export function OntologyClaimWorkbench({
  document,
  claimId,
  onDecided,
}: OntologyClaimWorkbenchProps): JSX.Element {
  const state = useClaimBasis(document, claimId);
  const [scopeLost, setScopeLost] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const ready = state.phase === 'ready';
  useEffect((): void => {
    // 근거 줄이 화면 밖이면 가운데로 가져옵니다.
    if (ready) anchor.current?.scrollIntoView?.({ block: 'center' });
  }, [ready, claimId]);

  if (state.phase === 'loading')
    return (
      <p className={styles.state} role="status">
        원문을 불러오고 있습니다…
      </p>
    );
  if (state.phase === 'missing')
    return (
      <p className={styles.state} role="status">
        이미 처리되었거나 현재 목록에 없는 항목입니다. 목록을 새로고침해 주세요.
      </p>
    );
  if (state.phase === 'error')
    return (
      <p className={styles.state} role="alert">
        {state.message}
      </p>
    );
  if (scopeLost)
    return (
      <p className={styles.state} role="alert">
        연결 또는 작업 공간이 변경되었습니다. 목록을 새로고침해 주세요.
      </p>
    );

  const basis = state.basis;
  const lines = basis.body.split('\n');
  const range = evidenceRange(basis, lines);
  // 문서 정보는 접어 두되 근거 줄이 그 안에 있으면 펼친 채 보여 줍니다. 줄 번호는 원문 기준입니다.
  const infoEnd = frontMatterEnd(lines);
  const evidenceInInfo =
    infoEnd > 0 && range.start > 0 && range.start <= infoEnd;
  const infoShown = infoOpen || evidenceInInfo;
  return (
    <div className={styles.workbench}>
      <header className={styles.sourceHeader}>
        <strong>{documentDisplayName(document)}</strong>
        <Link to={`/document?path=${encodeURIComponent(document)}`}>
          문서 열기 ↗
        </Link>
      </header>
      <div className={styles.source} role="region" aria-label="원문">
        {infoEnd > 0 && (
          <button
            type="button"
            className={styles.infoToggle}
            aria-expanded={infoShown}
            disabled={evidenceInInfo}
            onClick={(): void => setInfoOpen(!infoShown)}
          >
            {infoShown ? '▾' : '▸'} 문서 정보 ({infoEnd}줄)
          </button>
        )}
        {lines.map((line: string, index: number): JSX.Element | null => {
          const number = index + 1;
          if (number <= infoEnd && !infoShown) return null;
          const evidence = number >= range.start && number <= range.end;
          return (
            <Fragment key={number}>
              <div
                className={styles.row}
                data-evidence={evidence || undefined}
                ref={number === range.start ? anchor : undefined}
              >
                <span className={styles.lineNumber}>{number}</span>
                <span className={styles.lineText}>{line || ' '}</span>
              </div>
              {number === range.end && (
                <OntologyClaimJudgment
                  basis={basis}
                  onDecided={onDecided}
                  onInvalidate={(): void => setScopeLost(true)}
                />
              )}
            </Fragment>
          );
        })}
        {range.end === 0 && (
          <OntologyClaimJudgment
            basis={basis}
            onDecided={onDecided}
            onInvalidate={(): void => setScopeLost(true)}
          />
        )}
      </div>
    </div>
  );
}
