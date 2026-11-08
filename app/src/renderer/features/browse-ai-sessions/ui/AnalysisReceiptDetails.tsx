import type { JSX } from 'react';
import { Link } from 'react-router';
import type {
  AnalysisJob,
  AnalysisReceipt,
} from '@contracts/analysis.contract';
import { documentDisplayName } from '@renderer/domains/documents';
import { formatTimestampWithZone } from '@renderer/shared/lib/formatTimestamp';
import styles from './AiSessions.module.scss';

const statuses = {
  pass: '통과',
  fail: '확인 필요',
  not_run: '미실행',
  not_applicable: '해당 없음',
  error: '검사하지 못함',
} as const;
const verdicts = {
  supported: '원문에서 확인',
  contradicted: '원문과 불일치',
  unsupported: '원문 근거 부족',
  condition_loss: '조건 누락',
  ambiguous: '의미 불명확',
  omission: '내용 누락',
  schema_limit: '표현 범위의 한계',
  not_run: '미실행',
  undetermined: '판단 보류',
} as const;
const reviewers = {
  ai_self_check: '추출한 AI의 자체 점검',
  separate_ai: '별도 AI 점검',
  human_reported: '사람 검토로 보고됨',
  not_reported: '검토 방식 미제공',
} as const;
const methods: Record<string, string> = {
  verbatim: '원문 문자 보존',
  pdf_text: 'PDF 문자 읽기',
  ocr: '문자 인식',
  xlsx_values: '스프레드시트 값 읽기',
  docx_text: 'Word 문자 읽기',
};
const resultStates: Record<AnalysisReceipt['state'], string> = {
  draft: '미완료',
  complete: '저장 완료',
  pending_reconcile: '저장 결과 확인 필요',
  rejected: '제출 내용 확인 필요',
  storage_busy: '다른 저장 작업이 끝난 뒤 다시 확인해 주세요',
};

type AnalysisReceiptDetailsProps = { receipt: AnalysisReceipt };
type ValidatedReport = Extract<
  NonNullable<AnalysisReceipt['diagnostics']>,
  { validation: 'structure_and_source_checked' }
>['report'];
type RuleResult = {
  rule_id: string;
  status: keyof typeof statuses;
  reason: string;
};
type ReferenceDocument = NonNullable<
  AnalysisJob['analysis_basis_ref']
>['context_documents'][number];

/** 저장 판정과 원문·의미 검사 내용만 표시하며 내부 영수증 참조는 보존합니다. */
export function AnalysisReceiptDetails({
  receipt,
}: AnalysisReceiptDetailsProps): JSX.Element {
  const diagnostics = receipt.diagnostics;
  const report =
    diagnostics?.validation === 'structure_and_source_checked'
      ? diagnostics.report
      : null;
  return (
    <>
      <p>{resultStates[receipt.state]}</p>
      {receipt.receipt && (
        <p>
          {receipt.receipt.stage === 'prepare_wiki'
            ? '본문 준비'
            : '온톨로지 추출'}
          {' · '}미검토
        </p>
      )}
      {receipt.current_output && (
        <p>
          {receipt.current_output.status === 'current'
            ? '현재 문서에 반영된 결과입니다.'
            : receipt.current_output.status === 'changed'
              ? '이 결과를 저장한 뒤 문서나 검토 상태가 변경되었습니다.'
              : '현재 문서의 반영 상태를 확인하지 못했습니다.'}
        </p>
      )}
      {receipt.validation_report?.rule_results && (
        <details>
          <summary>자동 검사 결과</summary>
          <ul>
            {receipt.validation_report.rule_results.map(
              (rule: RuleResult): JSX.Element => (
                <li key={rule.rule_id}>
                  {statuses[rule.status]} · {rule.reason}
                </li>
              ),
            )}
          </ul>
        </details>
      )}
      {receipt.validation_report?.semantic.status === 'not_run' && (
        <p>의미 점검은 실행되지 않았습니다.</p>
      )}
      {diagnostics && !report && (
        <p>
          진단 보고의 형식을 확인하지 못해 검사 내용으로 표시할 수 없습니다.
        </p>
      )}
      {report && (
        <details>
          <summary>원문·의미 점검 내용</summary>
          <p>
            {reviewers[report.reviewer_kind]} · 사람의 승인을 의미하지 않습니다.
          </p>
          {report.reviewed_ranges.length > 0 && (
            <p>
              확인한 원문 범위 ·{' '}
              {report.reviewed_ranges
                .map(
                  (range: ValidatedReport['reviewed_ranges'][number]): string =>
                    `${range.start_line}–${range.end_line}행`,
                )
                .join(', ')}
            </p>
          )}
          {report.warnings.map(
            (warning: string, index: number): JSX.Element => (
              <p key={`warning:${index}`}>주의 · {warning}</p>
            ),
          )}
          {report.omissions.map(
            (omission: string, index: number): JSX.Element => (
              <p key={`omission:${index}`}>누락 · {omission}</p>
            ),
          )}
          {report.unread_ranges.map(
            (range: string, index: number): JSX.Element => (
              <p key={`unread:${index}`}>읽지 못한 범위 · {range}</p>
            ),
          )}
          {report.schema_version === 2 && (
            <ul>
              {report.rule_results.map((rule: RuleResult): JSX.Element => (
                <li key={rule.rule_id}>
                  {statuses[rule.status]} · {rule.reason}
                </li>
              ))}
            </ul>
          )}
          {report.findings.map(
            (
              finding: ValidatedReport['findings'][number],
              index: number,
            ): JSX.Element => (
              <section key={index}>
                <h4>{verdicts[finding.verdict]}</h4>
                <p>{finding.reason}</p>
                {finding.source && (
                  <>
                    <p>
                      원문 {finding.source.start_line}–{finding.source.end_line}
                      행
                    </p>
                    <blockquote>{finding.source.quote}</blockquote>
                  </>
                )}
                {finding.recommendation && (
                  <p>제안 · {finding.recommendation}</p>
                )}
                {finding.question && <p>확인할 질문 · {finding.question}</p>}
              </section>
            ),
          )}
          {report.schema_version === 2 &&
            report.semantic_check?.source_audit && (
              <details>
                <summary>원문 점검 내용</summary>
                <pre>{report.semantic_check.source_audit}</pre>
              </details>
            )}
        </details>
      )}
    </>
  );
}

type AnalysisJobContextProps = { job: AnalysisJob };

/** 분석 당시의 조회 범위·참고 문서·변환 한계를 사람이 읽는 정보로 보존합니다. */
export function AnalysisJobContext({
  job,
}: AnalysisJobContextProps): JSX.Element {
  const basis = job.analysis_basis_ref;
  const conversion = job.conversion;
  return (
    <details className={styles.record}>
      <summary>분석 당시의 범위와 변환 기록</summary>
      <p>작업 시작 · {formatTimestampWithZone(job.created_at)}</p>
      {basis && (
        <>
          <p>
            업무 영역 · {basis.profile.domain || '전체 영역'} / 관점 ·{' '}
            {basis.profile.viewpoint || '전체 관점'}
          </p>
          {basis.context_documents.length > 0 && (
            <ul>
              {basis.context_documents.map(
                (document: ReferenceDocument): JSX.Element => (
                  <li key={document.document}>
                    <Link
                      to={`/document?path=${encodeURIComponent(document.document)}`}
                    >
                      {documentDisplayName(document.document)}
                    </Link>
                    {document.required ? ' · 필수 참고' : ' · 참고'}
                    {document.reason && <p>{document.reason}</p>}
                  </li>
                ),
              )}
            </ul>
          )}
        </>
      )}
      {conversion && (
        <>
          <p>
            변환 방식 · {methods[conversion.method] || '변환 기록 확인 필요'}
          </p>
          <p>
            {conversion.complete
              ? '문자 읽기 완료로 보고됨'
              : '읽지 못한 부분이 있습니다'}
            . 의미 정확도와 사람 검토는 별도입니다.
          </p>
          {conversion.unread_ranges.map(
            (range: string, index: number): JSX.Element => (
              <p key={`unread:${index}`}>읽지 못한 범위 · {range}</p>
            ),
          )}
          {conversion.warnings.map(
            (warning: string, index: number): JSX.Element => (
              <p key={`warning:${index}`}>주의 · {warning}</p>
            ),
          )}
          {conversion.first_markdown && (
            <p>최초 변환 본문이 보관되어 있습니다.</p>
          )}
        </>
      )}
    </details>
  );
}
