import type { JSX } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { ProposalRecord } from '../model/analysisProposal.schema';
import { readDiagnosticFindings } from '../model/diagnosticFindings';
import type { DiagnosticFindingView } from '../model/diagnosticFindings';
import { ProposalClaimDetails } from './ProposalGraphDetails';
import { ProposalValue } from './ProposalValue';
import styles from './ReviewAnalysisProposals.module.scss';

type DiagnosticFindingsProps = {
  report: KnowledgeValue;
  record: ProposalRecord;
  onEditCandidate?: () => void;
  editingDisabled: boolean;
};
type ReportedItemsProps = { title: string; items: string[] };
const verdictLabels = {
  supported: '원문 지지 의견',
  contradicted: '모순 의견',
  unsupported: '근거 부족 의견',
  condition_loss: '조건 손실',
  ambiguous: '모호함',
  omission: '누락 의견',
  schema_limit: '스키마 표현 한계',
  not_run: '미실행',
  undetermined: '판단 불가',
};
const targetLabels = {
  entities: '개념',
  relations: '관계',
  attributes: '속성',
  relation_candidates: '추정 관계 후보',
};

/** 보고되지 않은 항목을 전체 원문의 무결함으로 해석하지 않습니다. */
function ReportedItems({ title, items }: ReportedItemsProps): JSX.Element {
  return (
    <section className={styles.reportedItems}>
      <h5>
        {title} · {items.length}건
      </h5>
      {items.length > 0 ? (
        <ul>
          {items.map((item: string, index: number): JSX.Element => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** 진단 원본과 같은 후보의 근거·대상을 읽고 기존 편집 화면으로만 이동합니다. */
export function DiagnosticFindings({
  report,
  record,
  onEditCandidate,
  editingDisabled,
}: DiagnosticFindingsProps): JSX.Element {
  const result = readDiagnosticFindings(report, record);
  if (!result.ok) return <p role="status">{result.message}</p>;
  const { findings } = result;
  return (
    <section className={styles.findings} aria-label="진단 항목과 검토 연결">
      <h4>진단 의견 · {findings.length}건</h4>
      <div className={styles.reportedSummary}>
        <ReportedItems title="경고" items={result.report.warnings} />
        <ReportedItems title="누락 보고" items={result.report.omissions} />
        <ReportedItems
          title="미독 범위 보고"
          items={result.report.unread_ranges}
        />
      </div>
      {findings.length > 0 ? (
        <ol className={styles.findingList}>
          {findings.map(
            (
              { finding, sourceText, target }: DiagnosticFindingView,
              index: number,
            ): JSX.Element => (
              <li key={index} className={styles.finding}>
                <h5>
                  진단 {index + 1} · {verdictLabels[finding.verdict]}
                </h5>
                <p>{finding.reason}</p>
                <div className={styles.findingComparison}>
                  {finding.source && sourceText !== null ? (
                    <section aria-label={`진단 ${index + 1}의 원문 근거`}>
                      <p>
                        원문 인용 · {finding.source.start_line}–
                        {finding.source.end_line}행
                      </p>
                      <pre>{finding.source.quote}</pre>
                      <details>
                        <summary>해당 줄의 원문 전체</summary>
                        <pre>{sourceText}</pre>
                      </details>
                    </section>
                  ) : (
                    <p>원문 인용이 보고되지 않았습니다.</p>
                  )}
                  {finding.target && target ? (
                    <section aria-label={`진단 ${index + 1}의 후보 대상`}>
                      <p>
                        현재 후보의 {targetLabels[finding.target.collection]} ·{' '}
                        {finding.target.index + 1}번째
                      </p>
                      {finding.target.collection === 'entities' ? (
                        <ProposalValue
                          value={Object.fromEntries(
                            Object.entries(target).filter(
                              ([key]: [string, unknown]): boolean =>
                                key !== 'id',
                            ),
                          )}
                        />
                      ) : (
                        <ProposalClaimDetails
                          value={target}
                          graph={record.submission}
                        />
                      )}
                    </section>
                  ) : (
                    <p>
                      특정 후보 대상이 보고되지 않았습니다. 기존 주장과 자동
                      연결하지 않습니다.
                    </p>
                  )}
                </div>
                {finding.recommendation && (
                  <p>권고: {finding.recommendation}</p>
                )}
                {finding.question && <p>확인 질문: {finding.question}</p>}
              </li>
            ),
          )}
        </ol>
      ) : (
        <p>개별 진단이 보고되지 않았습니다.</p>
      )}
      <details>
        <summary>검토 범위 · {result.report.reviewed_ranges.length}개</summary>
        {result.report.reviewed_ranges.length > 0 ? (
          <ul>
            {result.report.reviewed_ranges.map(
              (
                range: (typeof result.report.reviewed_ranges)[number],
                index: number,
              ): JSX.Element => (
                <li key={index}>
                  {range.start_line}–{range.end_line}행
                </li>
              ),
            )}
          </ul>
        ) : (
          <p>검토 범위가 보고되지 않았습니다.</p>
        )}
        <p>분석 당시 원문 기준 · 전체 원문의 검토 완료를 뜻하지 않습니다.</p>
      </details>
      {onEditCandidate && (
        <Button
          variant="secondary"
          disabled={editingDisabled}
          onClick={(): void => {
            if (!editingDisabled) onEditCandidate();
          }}
        >
          진단을 보며 전체 추출 결과 편집
        </Button>
      )}
    </section>
  );
}
